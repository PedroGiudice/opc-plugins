---
name: tauri-appimage-updater
description: Workflow completo para auto-update self-hosted em apps Tauri v2. Cobre geração de AppImage no Oracle Linux, chave de assinatura, servidor nginx, compatibilidade cross-distro (OL10 para Ubuntu), e script de publicação. Use quando precisar configurar auto-update, gerar AppImage, publicar update, ou resolver problemas de AppImage em Oracle Linux.
---

# Tauri AppImage Auto-Update (Self-Hosted)

Workflow validado para configurar auto-update self-hosted em apps Tauri v2,
com build no Oracle Linux 10.1 e distribuição para Ubuntu/Debian.

## Visão Geral

```
[Oracle Linux VM]                    [Notebook Ubuntu]
  bun run tauri build                  AppImage v1.0
  publish-update.sh  ──nginx:8090──>   check latest.json
                                       download v2.0
                                       auto-restart
```

## Pre-requisitos (VM Oracle Linux)

```bash
# FUSE (obrigatório para AppImage)
sudo dnf install -y fuse fuse-libs

# nginx (servidor de updates)
sudo dnf install -y nginx
sudo systemctl enable --now nginx

# SELinux: liberar porta customizada
sudo semanage port -a -t http_port_t -p tcp 8090

# Diretório de updates
sudo mkdir -p /var/www/updates
sudo chown $USER:$USER /var/www/updates
```

## Passo 1: Chave de Assinatura

O Tauri usa minisign para assinar binários. Gerar par dedicado por projeto.

```bash
# --ci evita prompts interativos (obrigatório em ambientes sem TTY)
# -p define senha conhecida (obrigatório, não aceita vazia)
bun run tauri signer generate -w ~/.tauri/NOME_PROJETO.key --force --ci -p "x"
```

Isso cria:
- `~/.tauri/NOME_PROJETO.key` (chave privada, NUNCA commitar)
- `~/.tauri/NOME_PROJETO.key.pub` (chave pública, vai no tauri.conf.json)

Anotar a pubkey (base64) do output para o próximo passo.

## Passo 2: Configurar tauri.conf.json

```jsonc
{
  "version": "0.1.0",
  "bundle": {
    "active": true,
    // IMPORTANTE: apenas deb + appimage, NÃO rpm (desperdiça ~5 min)
    "targets": ["deb", "appimage"],
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      // Conteúdo COMPLETO do arquivo .key.pub (base64 com header)
      "pubkey": "CONTEUDO_DO_ARQUIVO_PUB_AQUI",
      // Obrigatório para HTTP (Tailscale não tem HTTPS)
      "dangerousInsecureTransportProtocol": true,
      "endpoints": [
        "http://IP_TAILSCALE:8090/latest.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

## Passo 3: Plugin Updater (Rust + Frontend)

### Cargo.toml
```toml
[dependencies]
tauri-plugin-updater = "2"
```

### lib.rs (registrar plugin)
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

### package.json
```bash
bun add @tauri-apps/plugin-updater
```

### Frontend (React) - Verificação automática
```typescript
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

useEffect(() => {
  const checkForUpdates = async () => {
    try {
      const update = await check();
      if (update) {
        await update.downloadAndInstall((event) => {
          if (event.event === 'Progress') {
            const data = event.data as { chunkLength: number; contentLength?: number };
            // Atualizar progress bar aqui
          }
        });
        if (confirm(`Nova versão ${update.version} instalada! Reiniciar?`)) {
          await relaunch();
        }
      }
    } catch (e) {
      console.log('Update check failed (normal in dev):', e);
    }
  };
  setTimeout(checkForUpdates, 3000);
}, []);
```

## Passo 4: Configurar nginx

```bash
cat | sudo tee /etc/nginx/conf.d/updates.conf << 'EOF'
server {
    listen 8090;
    server_name _;
    root /var/www/updates;
    autoindex on;
    location / {
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods 'GET, OPTIONS';
    }
}
EOF

sudo nginx -t && sudo systemctl restart nginx
```

## Passo 5: Variáveis de Ambiente

Adicionar ao `~/.bashrc`:

```bash
export TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/NOME_PROJETO.key 2>/dev/null)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="x"
```

## Passo 6: Build

```bash
# TODAS as variáveis são obrigatórias no Oracle Linux:
TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/NOME_PROJETO.key) \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="x" \
NO_STRIP=true \
APPIMAGE_EXTRACT_AND_RUN=1 \
bun run tauri build
```

| Variável | Por que |
|----------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Assinar os artefatos (.sig) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Senha da chave (definida no passo 1) |
| `NO_STRIP=true` | linuxdeploy bundled `strip` não suporta `.relr.dyn` do OL10 |
| `APPIMAGE_EXTRACT_AND_RUN=1` | Evita problemas de FUSE durante build |

## Passo 7: Fix Cross-Distro (OL10 → Ubuntu)

O AppImage empacota `libgcrypt.so.20` do OL10 mas NÃO `libgpg-error.so.0`.
No Ubuntu, isso causa: `symbol lookup error: undefined symbol: gpgrt_add_post_log_func`.

A correção é reempacotar o AppImage adicionando a lib faltante:

```bash
# 1. Extrair
APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE" --appimage-extract

# 2. Adicionar lib faltante
cp /lib64/libgpg-error.so.0 squashfs-root/usr/lib/

# 3. Reempacotar (appimagetool do cache do Tauri)
APPIMAGETOOL_DIR=$(mktemp -d)
cd "$APPIMAGETOOL_DIR"
APPIMAGE_EXTRACT_AND_RUN=1 ~/.cache/tauri/linuxdeploy-plugin-appimage.AppImage --appimage-extract
ARCH=x86_64 NO_STRIP=true squashfs-root/usr/bin/appimagetool /path/to/squashfs-root output.AppImage

# 4. Re-assinar
bun run tauri signer sign output.AppImage -k "$TAURI_SIGNING_PRIVATE_KEY" -p "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
```

## Passo 8: Publicar

O script `scripts/publish-update.sh` automatiza tudo:
1. Lê versão do `tauri.conf.json`
2. Extrai AppImage, adiciona `libgpg-error.so.0`, reempacota
3. Re-assina com a chave do projeto
4. Copia para `/var/www/updates/`
5. Gera `latest.json`
6. Corrige SELinux
7. Verifica servidor

```bash
./scripts/publish-update.sh
```

### Formato do latest.json

```json
{
  "version": "1.0.0",
  "notes": "Descrição da release",
  "pub_date": "2026-02-05T06:20:28Z",
  "platforms": {
    "linux-x86_64": {
      "signature": "CONTEUDO_DO_ARQUIVO_SIG",
      "url": "http://IP_TAILSCALE:8090/Pro%20ATT%20Machine_1.0.0_amd64.AppImage"
    }
  }
}
```

## Passo 9: Testar Update

1. Instalar versão N no notebook (baixar via scp, chmod +x, executar)
2. Bumpar versão para N+1 no `tauri.conf.json` e `package.json`
3. Rebuildar e publicar com `./scripts/publish-update.sh`
4. Reabrir AppImage versão N → deve detectar N+1 e oferecer atualização

## Regra Crítica: Sem CDN no AppImage

O AppImage empacota GnuTLS do OL10 que não encontra certificados CA no Ubuntu.
Resultado: TODAS as requisições HTTPS do WebView falham silenciosamente.

**Se o app usa Tailwind CDN** (`<script src="https://cdn.tailwindcss.com">`):

```bash
# Instalar Tailwind como dependência de build
bun add -D tailwindcss@3 postcss autoprefixer
```

Criar `tailwind.config.js`, `postcss.config.js`, CSS entry com `@tailwind` directives,
importar no entry point, e remover a tag `<script>` do CDN.

Mesma regra para qualquer recurso externo via HTTPS (fontes, scripts, etc.).

## Checklist Rápido

- [ ] `fuse` instalado na VM (`dnf install fuse`)
- [ ] Chave gerada com `--ci -p "x"`
- [ ] `pubkey` no `tauri.conf.json` bate com `.key.pub`
- [ ] `targets: ["deb", "appimage"]` (sem rpm)
- [ ] `createUpdaterArtifacts: true`
- [ ] `dangerousInsecureTransportProtocol: true` (se HTTP)
- [ ] nginx na porta 8090 com CORS
- [ ] Build com `NO_STRIP=true APPIMAGE_EXTRACT_AND_RUN=1`
- [ ] `libgpg-error.so.0` incluída no AppImage
- [ ] SELinux: `chcon -R -t httpd_sys_content_t /var/www/updates/`
- [ ] Nenhum recurso carregado via CDN/HTTPS no frontend
- [ ] `latest.json` com platform key `linux-x86_64`
