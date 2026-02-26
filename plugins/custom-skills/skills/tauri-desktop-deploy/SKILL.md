---
name: tauri-desktop-deploy
description: Deploy de apps Tauri (AppImage) em desktops Linux remotos via Tailscale SSH. Cobre autorização SSH, transferência SCP, criação de .desktop launcher, diagnóstico remoto de crashes, e patch de bibliotecas cross-distro. Use quando precisar instalar, atualizar, ou debugar um app Tauri em máquina remota.
---

# Tauri Desktop Deploy (Tailscale SSH)

Script de deploy para apps Tauri (AppImage) em desktops Linux remotos.
Executar os passos na ordem. Substituir os placeholders em MAIÚSCULAS.

## Variáveis (definir antes de começar)

```bash
APP_NAME="Nome Do App"              # Nome exibido no menu
APP_SLUG="nome-do-app"              # Sem espaços, lowercase
VERSAO="0.1.0"                      # Versão atual
USUARIO="cmr-auto"                  # User no desktop remoto
IP_DESKTOP="100.102.249.9"          # IP Tailscale do desktop
IP_BUILD="100.114.203.28"           # IP Tailscale do build server
PORTA_HTTP="8090"                   # Porta do nginx
PROJETO="nomedoprojeto"             # Subdiretório em /var/www/updates/
TAURI_KEY="~/.tauri/$PROJETO.key"   # Chave privada de assinatura
TAURI_KEY_PASS="x"                  # Senha da chave
```

---

## 1. Autorizar SSH (uma vez por máquina)

```bash
# No build server: publicar chave pública
cp ~/.ssh/id_ed25519.pub /var/www/updates/$PROJETO/vm-key.pub
```

Usuário executa no desktop remoto:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
curl http://IP_BUILD:PORTA_HTTP/PROJETO/vm-key.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Testar:

```bash
ssh -o ConnectTimeout=5 $USUARIO@$IP_DESKTOP "echo OK && hostname"
```

---

## 2. Enviar AppImage

```bash
APPIMAGE="src-tauri/target/release/bundle/appimage/${APP_NAME}_${VERSAO}_amd64.AppImage"
scp "$APPIMAGE" "$USUARIO@$IP_DESKTOP:~/"
ssh $USUARIO@$IP_DESKTOP "chmod +x ~/'${APP_NAME}_${VERSAO}_amd64.AppImage'"
```

---

## 3. Criar .desktop (launcher no menu)

```bash
printf '[Desktop Entry]\nName=%s\nComment=%s v%s\nExec="/home/%s/%s_%s_amd64.AppImage"\nIcon=application-x-appimage\nTerminal=false\nType=Application\nCategories=Utility;\n' \
  "$APP_NAME" "$APP_NAME" "$VERSAO" "$USUARIO" "$APP_NAME" "$VERSAO" \
  > /tmp/$APP_SLUG.desktop

scp /tmp/$APP_SLUG.desktop $USUARIO@$IP_DESKTOP:~/.local/share/applications/
ssh $USUARIO@$IP_DESKTOP "update-desktop-database ~/.local/share/applications/ 2>/dev/null"
```

Se o Exec contém espaços: as aspas duplas no printf já protegem.
Se `not a key-value pair`: o caminho quebrou em múltiplas linhas -- usar printf, nunca heredoc.

---

## 4. Diagnosticar crash

```bash
ssh $USUARIO@$IP_DESKTOP "DISPLAY=:0 '/home/$USUARIO/${APP_NAME}_${VERSAO}_amd64.AppImage' 2>&1 | head -50"
```

Ignorar `Failed to initialize gtk backend` (normal via SSH, sem display).
O que importa: erros de biblioteca ANTES do gtk init.

### Se `symbol lookup error: undefined symbol`

```bash
# Verificar se o símbolo existe no desktop
ssh $USUARIO@$IP_DESKTOP "nm -D /lib/x86_64-linux-gnu/LIB_NOME.so | grep SIMBOLO"
# Saída vazia = versão do desktop não tem esse símbolo -> passo 5
```

### Se `libwebkit2gtk` ou `libgtk` errors

```bash
ssh $USUARIO@$IP_DESKTOP "sudo apt install -y libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1"
```

---

## 5. Patch de bibliotecas cross-distro

Executar quando lib empacotada no AppImage depende de lib do sistema com versão diferente.

```bash
# 5.1 Extrair
cd /tmp && rm -rf appimage-fix && mkdir appimage-fix && cd appimage-fix
APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE" --appimage-extract

# 5.2 Copiar lib faltante da VM para dentro do AppImage
cp /lib64/LIB_FALTANTE.so.X squashfs-root/usr/lib/

# 5.3 Baixar appimagetool (se não existir)
test -f /tmp/appimagetool || {
  curl -L -o /tmp/appimagetool https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x /tmp/appimagetool
}

# 5.4 Reempacotar
ARCH=x86_64 NO_STRIP=1 /tmp/appimagetool squashfs-root "${APP_NAME}_${VERSAO}_amd64.AppImage"

# 5.5 Re-assinar (flag -f para arquivo, -p para senha)
bun run tauri signer sign -f $TAURI_KEY -p "$TAURI_KEY_PASS" "${APP_NAME}_${VERSAO}_amd64.AppImage"

# 5.6 Enviar corrigido
scp "${APP_NAME}_${VERSAO}_amd64.AppImage" "$USUARIO@$IP_DESKTOP:~/"
ssh $USUARIO@$IP_DESKTOP "chmod +x ~/'${APP_NAME}_${VERSAO}_amd64.AppImage'"
```

### Incompatibilidades conhecidas (Oracle Linux 10 -> Ubuntu 24.04)

| Lib empacotada | Adicionar ao AppImage | Sintoma |
|----------------|-----------------------|---------|
| `libgcrypt.so.20` | `libgpg-error.so.0` | `undefined symbol: gpgrt_add_post_log_func` |
| `libgnutls.so.30` | Nenhuma lib resolve -- não usar CDN HTTPS | HTTPS falha no WebView |

Regra: se uma lib é empacotada, TODAS as dependências diretas devem ir junto.

---

## 6. Atualizar app existente

```bash
# Matar processo anterior
ssh $USUARIO@$IP_DESKTOP "pkill -f '${APP_NAME}' 2>/dev/null; sleep 1"

# Enviar nova versão
scp "$APPIMAGE" "$USUARIO@$IP_DESKTOP:~/"
ssh $USUARIO@$IP_DESKTOP "chmod +x ~/'${APP_NAME}_${VERSAO}_amd64.AppImage'"

# Atualizar .desktop (se versão mudou)
printf '[Desktop Entry]\nName=%s\nComment=%s v%s\nExec="/home/%s/%s_%s_amd64.AppImage"\nIcon=application-x-appimage\nTerminal=false\nType=Application\nCategories=Utility;\n' \
  "$APP_NAME" "$APP_NAME" "$VERSAO" "$USUARIO" "$APP_NAME" "$VERSAO" \
  > /tmp/$APP_SLUG.desktop
scp /tmp/$APP_SLUG.desktop $USUARIO@$IP_DESKTOP:~/.local/share/applications/
```

---

## 7. Publicar no update server (após patch, se aplicável)

```bash
# Copiar para nginx
cp "${APP_NAME}_${VERSAO}_amd64.AppImage" /var/www/updates/$PROJETO/
cp "${APP_NAME}_${VERSAO}_amd64.AppImage.sig" /var/www/updates/$PROJETO/

# Atualizar latest.json
SIG=$(cat "${APP_NAME}_${VERSAO}_amd64.AppImage.sig")
URL_ENCODED=$(echo "${APP_NAME}_${VERSAO}_amd64.AppImage" | sed 's/ /%20/g')

printf '{\n  "version": "%s",\n  "notes": "%s v%s",\n  "pub_date": "%s",\n  "platforms": {\n    "linux-x86_64": {\n      "signature": "%s",\n      "url": "http://%s:%s/%s/%s"\n    }\n  }\n}\n' \
  "$VERSAO" "$APP_NAME" "$VERSAO" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$SIG" "$IP_BUILD" "$PORTA_HTTP" "$PROJETO" "$URL_ENCODED" \
  > /var/www/updates/$PROJETO/latest.json

# SELinux (Oracle Linux)
sudo chcon -R -t httpd_sys_content_t /var/www/updates/$PROJETO/ 2>/dev/null

# Verificar
curl -s http://$IP_BUILD:$PORTA_HTTP/$PROJETO/latest.json | python3 -m json.tool
```

---

## Checklist

- [ ] SSH funciona (`ssh $USUARIO@$IP_DESKTOP "echo OK"`)
- [ ] AppImage no desktop com `chmod +x`
- [ ] .desktop com Exec entre aspas (espaços no nome)
- [ ] `update-desktop-database` executado
- [ ] App abre sem crash
- [ ] Se cross-distro: libs patcheadas (passo 5)
- [ ] Se auto-update: AppImage re-assinado e latest.json atualizado
- [ ] Processo anterior morto antes de enviar nova versão
