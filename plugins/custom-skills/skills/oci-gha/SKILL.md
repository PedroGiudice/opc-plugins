---
name: oci-gha
description: Use when setting up GitHub Actions CI/CD for Legal Workbench, configuring OCI secrets, or troubleshooting Oracle Cloud CLI. Reference for automated pipelines.
---

# OCI e GitHub Actions Reference

Referencia para CI/CD automatizado do Legal Workbench no Oracle Cloud.

**NOTA:** Para deploy manual, use a skill `/deploy`.

---

## GitHub Actions - CI Workflow

**Arquivo:** `.github/workflows/ci.yml`
**Trigger:** Push para qualquer branch, PRs para main
**Jobs:** lint, test, build

```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:
    branches: [main]

env:
  REGISTRY: sa-saopaulo-1.ocir.io

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Lint Python
        run: |
          pip install ruff
          ruff check legal-workbench/docker/services/

      - name: Set up Bun
        uses: oven-sh/setup-bun@v2

      - name: Lint Frontend
        run: |
          cd legal-workbench/frontend
          bun install
          bun run lint

  test:
    runs-on: ubuntu-latest
    needs: lint
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Run Python tests
        run: |
          pip install pytest
          pytest legal-workbench/docker/services/ -v

      - name: Set up Bun
        uses: oven-sh/setup-bun@v2

      - name: Run Frontend tests
        run: |
          cd legal-workbench/frontend
          bun install
          bun run test || true

  build:
    runs-on: ubuntu-latest
    needs: test
    strategy:
      matrix:
        service:
          - frontend-react
          - api-stj
          - api-text-extractor
          - api-doc-assembler
          - api-ledes-converter
          - api-trello
          - api-ccui-ws
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build image
        uses: docker/build-push-action@v5
        with:
          context: ./legal-workbench
          file: ./legal-workbench/docker/services/${{ matrix.service }}/Dockerfile
          push: false
          tags: ${{ env.REGISTRY }}/legal-workbench/${{ matrix.service }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

---

## GitHub Actions - CD Workflow

**Arquivo:** `.github/workflows/cd.yml`
**Trigger:** Push para main, workflow_dispatch
**Jobs:** build-and-push, deploy

```yaml
name: CD - Deploy to Oracle Cloud

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  OCI_CLI_USER: ${{ secrets.OCI_USER_OCID }}
  OCI_CLI_TENANCY: ${{ secrets.OCI_TENANCY_OCID }}
  OCI_CLI_FINGERPRINT: ${{ secrets.OCI_FINGERPRINT }}
  OCI_CLI_KEY_CONTENT: ${{ secrets.OCI_PRIVATE_KEY }}
  OCI_CLI_REGION: sa-saopaulo-1
  REGISTRY: sa-saopaulo-1.ocir.io
  NAMESPACE: ${{ secrets.OCI_NAMESPACE }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service:
          - name: frontend-react
            context: ./legal-workbench
            dockerfile: ./legal-workbench/frontend/Dockerfile
          - name: api-stj
            context: ./legal-workbench
            dockerfile: ./legal-workbench/docker/services/stj-api/Dockerfile
          - name: api-text-extractor
            context: ./legal-workbench
            dockerfile: ./legal-workbench/docker/services/text-extractor/Dockerfile
          - name: api-doc-assembler
            context: ./legal-workbench
            dockerfile: ./legal-workbench/docker/services/doc-assembler/Dockerfile
          - name: api-ledes-converter
            context: ./legal-workbench
            dockerfile: ./legal-workbench/docker/services/ledes-converter/Dockerfile
          - name: api-trello
            context: ./legal-workbench
            dockerfile: ./legal-workbench/docker/services/trello-mcp/Dockerfile
          - name: api-ccui-ws
            context: ./legal-workbench
            dockerfile: ./legal-workbench/docker/services/ccui-ws/Dockerfile

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to OCIR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ env.NAMESPACE }}/oracleidentitycloudservice/${{ secrets.OCI_USER_EMAIL }}
          password: ${{ secrets.OCI_AUTH_TOKEN }}

      - name: Generate version tag
        id: version
        run: |
          VERSION=$(date +'%Y%m%d')-$(git rev-parse --short HEAD)
          echo "tag=$VERSION" >> $GITHUB_OUTPUT

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ${{ matrix.service.context }}
          file: ${{ matrix.service.dockerfile }}
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.NAMESPACE }}/legal-workbench/${{ matrix.service.name }}:${{ steps.version.outputs.tag }}
            ${{ env.REGISTRY }}/${{ env.NAMESPACE }}/legal-workbench/${{ matrix.service.name }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.OCI_INSTANCE_IP }}
          username: opc
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /opt/legal-workbench

            # Login OCIR
            echo "${{ secrets.OCI_AUTH_TOKEN }}" | docker login ${{ env.REGISTRY }} \
              -u "${{ env.NAMESPACE }}/oracleidentitycloudservice/${{ secrets.OCI_USER_EMAIL }}" \
              --password-stdin

            # Pull e deploy
            docker-compose pull
            docker-compose up -d --remove-orphans

            # Verificacao
            sleep 10
            ./docker/scripts/health-check.sh || {
              echo "Health check failed, rolling back..."
              docker-compose down
              docker-compose up -d
              exit 1
            }

            echo "Deploy successful!"
```

---

## GitHub Secrets Necessarios

| Secret | Descricao |
|--------|-----------|
| `OCI_USER_OCID` | OCID do usuario OCI |
| `OCI_TENANCY_OCID` | OCID do tenancy |
| `OCI_FINGERPRINT` | Fingerprint da API key |
| `OCI_PRIVATE_KEY` | Private key (PEM) |
| `OCI_NAMESPACE` | Namespace do OCIR |
| `OCI_USER_EMAIL` | Email do usuario OCI |
| `OCI_AUTH_TOKEN` | Auth token para OCIR |
| `OCI_INSTANCE_IP` | IP publico da instancia (137.131.201.119) |
| `SSH_PRIVATE_KEY` | Chave SSH privada |

---

## OCIR (Container Registry)

**Registry:** `sa-saopaulo-1.ocir.io`
**Formato:** `<region>.ocir.io/<namespace>/legal-workbench/<service>:<tag>`

**Login manual:**
```bash
docker login sa-saopaulo-1.ocir.io \
  -u <namespace>/oracleidentitycloudservice/<user> \
  -p <auth_token>
```

---

## OCI CLI Reference

**Servidor:** `opc@137.131.201.119`
**Regiao:** `sa-saopaulo-1`
**Config:** `~/.oci/config`

### Comandos de Descoberta

```bash
# Ver todos os servicos
oci --help

# Ver comandos de um servico
oci compute --help
oci bv --help          # Block Volume
oci os --help          # Object Storage
oci iam --help         # Identity and Access Management

# Ver opcoes de um comando
oci compute instance list --help
```

### Outputs e Debug

```bash
# Output em tabela
oci <comando> --output table

# Query JMESPath
oci <comando> --query 'data[*].{name:"display-name", id:id}'

# Debug verboso
oci <comando> --debug
```

### Erros Comuns

| Erro | Acao |
|------|------|
| `NotAuthenticated` | Verificar ~/.oci/config |
| `NotAuthorizedOrNotFound` | Verificar OCID e permissoes |
| `ServiceError 404` | Recurso nao existe |
| Comando desconhecido | Usar WebSearch para descobrir sintaxe |

---

## Gaps Conhecidos

### CRITICO
- Sem versionamento de imagens (todas usam :latest)
- Secrets em .env file (texto plano)
- Backup apenas local

### ALTO
- Sem OCIR repositories provisionados
- SSL manual (Traefik sem Let's Encrypt automatico)

### MEDIO
- Sem resource limits nos containers
- Alertmanager nao configurado
