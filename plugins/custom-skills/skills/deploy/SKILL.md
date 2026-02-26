---
name: deploy
description: Use when deploying Legal Workbench to Oracle Cloud, building Docker images, or checking service health. Invoke via /deploy.
---

# Deploy Legal Workbench

Roteiro prescritivo para build e deploy do Legal Workbench no Oracle Cloud.

**IMPORTANTE:** Siga este roteiro LITERALMENTE. Nao improvise, nao pule etapas.

---

## Quick Reference

| Operacao | Comando |
|----------|---------|
| Build frontend local | `cd legal-workbench/frontend && bun run build` |
| Build Docker | `cd legal-workbench && docker compose build --parallel` |
| Sync para OCI | `rsync -avz --delete --exclude=node_modules --exclude=.git --exclude=e2e -e "ssh -i ~/.ssh/oci_lw" ./<service>/ opc@137.131.201.119:/home/opc/lex-vector/legal-workbench/<service>/` |
| Deploy no servidor | `ssh -i ~/.ssh/oci_lw opc@137.131.201.119 "cd /home/opc/lex-vector/legal-workbench && docker compose build <service> && docker compose up -d <service>"` |
| Health check | `docker compose ps` ou `curl http://localhost:<porta>/health` |

---

## 1. Desenvolvimento Local

```
Developer Machine
     |
     v
+------------------+
| bun run dev      |  <- Frontend hot reload (Vite)
| uv run uvicorn   |  <- Backend hot reload (FastAPI)
+------------------+
```

**Frontend:**
```bash
cd legal-workbench/frontend
bun install          # Instalar dependencias
bun run dev          # Dev server com HMR (porta 5173)
bun run build        # Build producao -> dist/
bun run lint         # ESLint
bun run type-check   # TypeScript check
```

**Backend (cada servico):**
```bash
cd legal-workbench/docker/services/<service>
uv sync              # Instalar dependencias
uv run uvicorn app.main:app --reload  # Dev server
```

---

## 2. Build Docker Local

```
Source Code
     |
     v
+------------------+
| docker compose   |
| build            |
+------------------+
     |
     v
+------------------+
| Local Images     |
| (tagged :latest) |
+------------------+
```

**Comando:**
```bash
cd legal-workbench
docker compose build --parallel
```

**Servicos buildados:**

| Servico | Dockerfile | Base Image |
|---------|------------|------------|
| frontend-react | frontend/Dockerfile | oven/bun:alpine + nginx:alpine |
| api-stj | docker/services/stj-api/Dockerfile | python:3.11-slim |
| api-text-extractor | docker/services/text-extractor/Dockerfile | python:3.11-slim |
| api-doc-assembler | docker/services/doc-assembler/Dockerfile | python:3.11-slim |
| api-ledes-converter | docker/services/ledes-converter/Dockerfile | python:3.11-slim |
| api-trello | docker/services/trello-mcp/Dockerfile | oven/bun:alpine |
| api-ccui-ws | docker/services/ccui-ws/Dockerfile | python:3.11-slim |

---

## 3. Deploy para Oracle Cloud

```
Local Machine                    OCI Server (137.131.201.119)
     |                                    |
     v                                    |
+------------------+                      |
| rsync -avz       |  ----------------->  |
| (source files)   |                      v
+------------------+              +------------------+
                                  | docker compose   |
                                  | build            |
                                  +------------------+
                                          |
                                          v
                                  +------------------+
                                  | docker compose   |
                                  | up -d            |
                                  +------------------+
                                          |
                                          v
                                  +------------------+
                                  | Traefik          |
                                  | (reverse proxy)  |
                                  +------------------+
```

### Passo 1: Build local (validacao)
```bash
cd legal-workbench/frontend
bun run build
```

### Passo 2: Sync para servidor
```bash
rsync -avz --delete \
  --exclude=node_modules --exclude=.git --exclude=e2e \
  -e "ssh -i ~/.ssh/oci_lw" \
  ./frontend/ opc@137.131.201.119:/home/opc/lex-vector/legal-workbench/frontend/
```

### Passo 3: Build e restart no servidor
```bash
ssh -i ~/.ssh/oci_lw opc@137.131.201.119 \
  "cd /home/opc/lex-vector/legal-workbench && \
   docker compose build frontend-react && \
   docker compose up -d frontend-react"
```

---

## 4. Arquitetura de Servicos em Producao

```
Internet (porta 80)
        |
        v
+------------------+
| Traefik v3.6.5   |  <- Reverse proxy, routing, SSL
+------------------+
        |
        +---> / ---------> frontend-react:3000 (nginx)
        |
        +---> /api/stj --> api-stj:8000 (FastAPI)
        |
        +---> /api/text -> api-text-extractor:8001 (FastAPI)
        |
        +---> /api/doc --> api-doc-assembler:8002 (FastAPI)
        |
        +---> /api/ledes -> api-ledes-converter:8003 (FastAPI)
        |
        +---> /api/trello -> api-trello:8004 (Bun)
        |
        +---> /ws, /api/chat -> api-ccui-ws:8005 (FastAPI)
```

**Tabela completa de servicos:**

| Servico | Rota Traefik | Porta | Stack |
|---------|--------------|-------|-------|
| reverse-proxy | N/A | 80, 8080 | Traefik v3.6.5 |
| frontend-react | `/` | 3000 | Bun + Nginx |
| api-stj | `/api/stj` | 8000 | Python/FastAPI |
| api-text-extractor | `/api/text` | 8001 | Python/FastAPI + Celery |
| api-doc-assembler | `/api/doc` | 8002 | Python/FastAPI |
| api-ledes-converter | `/api/ledes` | 8003 | Python/FastAPI |
| api-trello | `/api/trello` | 8004 | Bun |
| api-ccui-ws | `/ws`, `/api/chat` | 8005 | Python/FastAPI |
| redis | N/A | 6379 | Redis 7 Alpine |
| prometheus | N/A | 9090 | Prometheus v2.47.0 |

---

## 5. Health Check

**Via Docker (interno):**
```bash
docker compose ps  # Mostra status "healthy"
```

**Via HTTP (externo):**
```bash
curl http://localhost:3000/           # Frontend
curl http://localhost:8000/health     # STJ API
curl http://localhost:8001/health     # Text Extractor
curl http://localhost:8002/health     # Doc Assembler
curl http://localhost:8003/health     # LEDES Converter
curl http://localhost:8004/health     # Trello API
curl http://localhost:8005/health     # CCUI WebSocket
curl http://localhost:9090/-/healthy  # Prometheus
```

---

## 6. Scripts Existentes

```
legal-workbench/docker/scripts/
├── deploy.sh         # Deploy com backup pre-deploy
├── backup.sh         # Backup de volumes e configs
├── health-check.sh   # Verifica todos os servicos
├── rollback.sh       # Restaura backup anterior
├── smoke-test.sh     # Testes funcionais basicos
├── status.sh         # Status dos containers
└── logs.sh           # Visualizacao de logs
```

---

## 7. Comandos Uteis

```bash
# Status dos containers
docker compose ps

# Logs de um servico (follow)
docker compose logs -f api-text-extractor

# Rebuild e restart de um servico
docker compose build api-stj && docker compose up -d api-stj

# Health check manual
./docker/scripts/health-check.sh

# Ver uso de recursos
docker stats --no-stream
```

---

## 8. Rollback (se necessario)

```bash
# Ver imagens anteriores
docker images | grep legal-workbench

# Rebuild com cache limpo
docker compose build --no-cache frontend-react

# Ou reverter via git e rebuild
git checkout <commit-anterior>
docker compose build && docker compose up -d
```

---

## 9. Checklist de Deploy

```
PRE-DEPLOY
[ ] Build local passou (bun run build)
[ ] Lint passou (bun run lint)
[ ] Type-check passou (bun run type-check)

DEPLOY
[ ] rsync concluido sem erros
[ ] docker compose build concluido
[ ] docker compose up -d executado

POS-DEPLOY
[ ] Health check passou (todos servicos "healthy")
[ ] Teste manual no browser OK
```

---

## 10. Fluxo Resumido

1. **Dev:** `bun run dev` (frontend) + `uv run uvicorn` (backend)
2. **Validate:** `bun run build && bun run lint && bun run type-check`
3. **Commit:** `git commit` com mensagem semantica
4. **Push:** `git push` para branch
5. **Deploy:** `rsync` + `docker compose build` + `up -d`
6. **Verify:** Health check + teste manual no browser
