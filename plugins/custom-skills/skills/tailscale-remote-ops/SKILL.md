---
name: tailscale-remote-ops
description: Operacoes remotas entre VM Oracle e PC Linux via Tailscale. SSH, SCP, tuneis, diagnostico remoto, firewall, authorized_keys. Use quando precisar transferir arquivos, executar comandos remotos, configurar acesso SSH, abrir portas, ou diagnosticar conectividade entre maquinas.
---

# Tailscale Remote Ops

Referencia operacional para comunicacao entre maquinas via Tailscale.

---

## Inventario de Maquinas

| Alias | Hostname Tailscale | IP Tailscale | User SSH | Papel | SO |
|-------|-------------------|--------------|----------|-------|----|
| VM | instance-20260126-0353 | 100.114.203.28 | opc | Build server, dev, CI | Oracle Linux |
| PC | cmrlinuxmachine | 100.102.249.9 | cmr-auto | Desktop local (Dell Vostro 3710, i5-12400, 16GB) | Ubuntu |
| Celular | samsung-sm-s921b | 100.84.227.100 | - | Mobile (Android, Tailscale app) | Android |

**Nota:** Hosts podem mudar de nome. Sempre verificar com `tailscale status`.

---

## Comandos Essenciais

### Verificar Conectividade

```bash
# Status de todas as maquinas
tailscale status

# Ping (verifica rota direta vs relay)
tailscale ping 100.102.249.9

# Testar SSH
ssh -o ConnectTimeout=5 cmr-auto@100.102.249.9 "echo OK"
```

### SSH - Conexao Remota

```bash
# VM -> PC
ssh cmr-auto@100.102.249.9

# PC -> VM
ssh opc@100.114.203.28

# Executar comando remoto (sem terminal interativo)
ssh cmr-auto@100.102.249.9 "df -h / && free -h"

# Executar script remoto com heredoc
ssh cmr-auto@100.102.249.9 bash -s << 'SCRIPT'
echo "rodando no PC"
uname -a
SCRIPT

# Comando com sudo remoto
ssh cmr-auto@100.102.249.9 "sudo systemctl status tailscaled"
```

### SCP - Transferencia de Arquivos

```bash
# VM -> PC (enviar)
scp /caminho/local cmr-auto@100.102.249.9:~/destino/

# PC -> VM (receber, executado na VM)
scp cmr-auto@100.102.249.9:~/arquivo.txt /tmp/

# Diretorio inteiro
scp -r /pasta/ cmr-auto@100.102.249.9:~/destino/

# Arquivo com espacos no nome (escapar)
scp "opc@100.114.203.28:/var/www/updates/App Name_0.1.0.AppImage" ~/
```

### Rsync - Sincronizacao (melhor para projetos)

```bash
# VM -> PC (sincronizar projeto, excluindo lixo)
rsync -avz --delete \
  --exclude=node_modules --exclude=.git --exclude=target \
  -e "ssh" \
  /home/opc/projeto/ cmr-auto@100.102.249.9:~/projeto/

# PC -> VM
rsync -avz --exclude=node_modules \
  -e "ssh" \
  cmr-auto@100.102.249.9:~/projeto/ /home/opc/projeto/
```

---

## Setup SSH (primeira vez)

### Autorizar chave da VM no PC

```bash
# 1. Na VM: ver a chave publica
cat ~/.ssh/id_ed25519.pub

# 2. No PC: adicionar a chave
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "CHAVE_PUBLICA_AQUI" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### Autorizar chave do PC na VM

```bash
# 1. No PC: ver a chave publica
cat ~/.ssh/id_ed25519.pub

# 2. Na VM: adicionar a chave
echo "CHAVE_PUBLICA_AQUI" >> ~/.ssh/authorized_keys
```

### Gerar chave (se nao existir)

```bash
ssh-keygen -t ed25519 -C "usuario@maquina"
```

---

## Erros Comuns e Solucoes

### Permission denied (publickey)

```
user@100.102.249.9: Permission denied (publickey,password).
```

**Causa:** Chave SSH nao autorizada no destino.
**Solucao:** Adicionar chave publica ao `~/.ssh/authorized_keys` da maquina destino (ver Setup SSH acima).
**Verificacao:** `ssh -v usuario@IP` mostra qual chave esta tentando.

### Nome de usuario errado

**Causa:** Cada maquina tem seu usuario. VM = `opc`, PC = `cmr-auto`.
**Solucao:** Verificar com `whoami` na maquina destino. Usar o usuario correto no comando SSH.

### Maquina offline no Tailscale

```
tailscale status
# mostra "offline, last seen Xd ago"
```

**Causa:** Tailscale daemon nao esta rodando na maquina destino.
**Solucao no PC:**
```bash
sudo systemctl enable --now tailscaled
sudo tailscale up
```

### Conexao via relay (lenta)

```
tailscale ping 100.102.249.9
# mostra "via DERP(sao)" em vez de conexao direta
```

**Causa:** NAT restritivo ou firewall bloqueando UDP.
**Nota:** Funciona, so e mais lento. Se a rede do escritorio tem restricoes, relay e normal.

### Hostname Tailscale errado

```bash
# Renomear
sudo tailscale set --hostname=nome-desejado
```

---

## Tuneis SSH Reversos

Para expor um servico do PC na VM (ou vice-versa):

```bash
# Expor porta 5173 do PC como localhost:5173 na VM
ssh -R 5173:localhost:5173 opc@100.114.203.28

# Expor porta 3000 da VM como localhost:3000 no PC
ssh -R 3000:localhost:3000 cmr-auto@100.102.249.9
```

**Alternativa (sem tunel):** Configurar o servidor com `host: '0.0.0.0'` e acessar via IP Tailscale diretamente. Mais simples e persiste entre reboots.

Exemplo para Vite:
```ts
// vite.config.ts
server: { host: true }  // bind 0.0.0.0, acessivel via Tailscale IP
```

---

## Firewall (Oracle Linux na VM)

```bash
# Abrir porta
sudo firewall-cmd --add-port=8080/tcp --permanent
sudo firewall-cmd --reload

# Verificar portas abertas
sudo firewall-cmd --list-ports

# Remover porta
sudo firewall-cmd --remove-port=8080/tcp --permanent
sudo firewall-cmd --reload
```

---

## Diagnostico Remoto

```bash
# Disco
ssh cmr-auto@100.102.249.9 "df -h /"

# Memoria
ssh cmr-auto@100.102.249.9 "free -h"

# Processos pesados
ssh cmr-auto@100.102.249.9 "ps aux --sort=-%mem | head -10"

# Informacoes de hardware
ssh cmr-auto@100.102.249.9 "sudo dmidecode -t memory | grep -E 'Size|Type:|Speed'"

# Kernel e boot params
ssh cmr-auto@100.102.249.9 "cat /proc/cmdline"

# Docker
ssh cmr-auto@100.102.249.9 "sudo docker system df"

# Servicos systemd
ssh cmr-auto@100.102.249.9 "sudo systemctl status tailscaled"

# Reboot remoto (CUIDADO - perde conexao)
ssh cmr-auto@100.102.249.9 "sudo reboot"
```

---

## Administracao Tailscale

```bash
# Remover maquina (via painel web)
# Acesse: https://login.tailscale.com/admin/machines
# Encontre a maquina, 3 pontos, Remove

# Listar maquinas (local)
tailscale status

# Ver IP proprio
tailscale ip

# Logout (remove da rede)
sudo tailscale logout

# Reconectar
sudo tailscale up
```

---

## Padroes Aprendidos

1. **Acesso via IP Tailscale e mais simples que tuneis** — configurar `host: '0.0.0.0'` no servidor e acessar via IP direto
2. **Sempre verificar usuario SSH** — VM=opc, PC=cmr-auto, errar o usuario causa "Permission denied"
3. **Chaves SSH precisam ser autorizadas em cada direcao** — VM->PC e PC->VM sao independentes
4. **Heredocs funcionam bem via SSH** — usar `bash -s << 'SCRIPT'` para scripts multilinea remotos
5. **Oracle Linux usa firewall-cmd** — Ubuntu geralmente nao tem firewall ativo por padrao
6. **Relay via DERP e normal em redes corporativas** — funciona, so e mais lento
7. **GRUB config viaja com o SSD** — ao mover disco entre maquinas, `mem=` e outros parametros podem causar problemas
