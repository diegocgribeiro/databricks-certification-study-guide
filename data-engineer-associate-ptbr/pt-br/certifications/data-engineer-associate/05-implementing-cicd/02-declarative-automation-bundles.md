---
title: Declarative Automation Bundles
type: study-material
tags:
  - data-engineer-associate
  - cicd
  - declarative-automation-bundles
  - asset-bundles
  - databricks-cli
status: published
---

# Declarative Automation Bundles

## Visão geral

**Declarative Automation Bundles** (antigo **Databricks Asset Bundles**, frequentemente abreviado como **DABs**) descrevem Lakeflow Jobs, Lakeflow (Declarative) Pipelines, dashboards e outros ativos do workspace como YAML junto ao código-fonte. A **Databricks CLI** os valida e implanta. **Targets** (dev, test, prod) com **variables** e **overrides** permitem promover um único código entre ambientes — a espinha dorsal do domínio de CI/CD da prova.

> [!note] Atualização da plataforma (out/2026)
> "Databricks Asset Bundles foi renomeado para Declarative Automation Bundles" (16/03/2026). O grupo de comandos da CLI continua `databricks bundle` e o arquivo raiz continua `databricks.yml`. O exam guide usa o novo nome com "(antigo Databricks Asset Bundles)".

> [!abstract] Resumo
>
> - Um bundle é o `databricks.yml` (raiz) + YAMLs de recursos incluídos + código-fonte, versionados no Git
> - **Variables** (`${var.nome}`) são resolvidas no deploy a partir de `--var`, `BUNDLE_VAR_<nome>`, `variable-overrides.json`, valores do target ou o default, **nessa ordem de precedência**
> - **Targets** sobrescrevem configurações por ambiente. `mode: development` adiciona prefixo aos nomes e pausa triggers. `mode: production` adiciona validações de segurança
> - CLI: `databricks bundle validate`, `deploy -t <target>`, `run`, `summary`, `plan`, `destroy`

> [!tip] O que a prova cobra
>
> - Habilidades do exam guide: configuração por ambiente com variables e overrides em dev, test e prod; deploy de bundles para empacotar e promover jobs, pipelines e outros ativos; usar a Databricks CLI para validar, implantar e gerenciar bundles em CI/CD automatizado
> - Manter segredos fora do YAML (variáveis de ambiente `BUNDLE_VAR_` alimentadas pelos secrets do CI)
> - Diferenças entre modo development e production
> - O que cada comando da CLI faz

---

## Anatomia de um bundle

```text
orders-pipeline/
├── databricks.yml            # nome do bundle, includes, variables, targets
├── resources/
│   ├── orders_job.yml        # definição do Lakeflow Job
│   └── orders_pipeline.yml   # definição do Lakeflow (Declarative) Pipeline
├── src/
│   ├── ingest_orders.py
│   └── silver_orders.sql
└── tests/
```

```yaml
# databricks.yml
bundle:
  name: orders_pipeline

include:
  - resources/*.yml

variables:
  catalog:
    description: Catálogo do Unity Catalog para este ambiente
    default: dev
  warehouse_id:
    description: SQL warehouse usado pelas tasks SQL
    lookup:
      warehouse: "Shared Serverless"     # resolvido para um ID no deploy
  db_password:
    description: Senha do banco de origem (nunca commitada; fornecida pelo CI)

targets:
  dev:
    mode: development
    default: true
    workspace:
      host: https://dev-workspace.cloud.databricks.com

  test:
    workspace:
      host: https://test-workspace.cloud.databricks.com
    variables:
      catalog: test

  prod:
    mode: production
    workspace:
      host: https://prod-workspace.cloud.databricks.com
      root_path: /Workspace/Shared/.bundle/${bundle.name}/${bundle.target}
    variables:
      catalog: prod
    run_as:
      service_principal_name: 6d5c-orders-sp-application-id
```

```yaml
# resources/orders_job.yml
resources:
  jobs:
    orders_job:
      name: orders_job
      tasks:
        - task_key: refresh_pipeline
          pipeline_task:
            pipeline_id: ${resources.pipelines.orders_pipeline.id}
        - task_key: publish
          depends_on: [{task_key: refresh_pipeline}]
          notebook_task:
            notebook_path: ../src/ingest_orders.py
            base_parameters:
              catalog: ${var.catalog}
      schedule:
        quartz_cron_expression: "0 0 2 * * ?"
        timezone_id: UTC
```

## Variables e overrides

Declare variáveis em um mapeamento `variables` de nível superior e referencie como `${var.<nome>}` ([Substitutions and variables](https://docs.databricks.com/aws/en/dev-tools/bundles/variables)).

| Fonte do valor | Exemplo | Precedência |
| :--- | :--- | :---: |
| Opção `--var` da CLI | `databricks bundle deploy -t prod --var="catalog=prod"` | **1** (maior) |
| Variável de ambiente `BUNDLE_VAR_<nome>` | `export BUNDLE_VAR_db_password=$DB_PASSWORD` (de secrets do GitHub) | 2 |
| `.databricks/bundle/<target>/variable-overrides.json` | `{"catalog": "prod"}` | 3 |
| `variables` dentro de um **target** | `targets.prod.variables.catalog: prod` | 4 |
| `default` na declaração de nível superior | `default: dev` | 5 (menor) |

- **`lookup`** resolve o ID de um objeto pelo nome (`cluster`, `job`, `pipeline`, `warehouse`, ...). Dá erro se o nome não corresponder a nenhum objeto ou a mais de um
- `type: complex` permite valores estruturados, como uma definição inteira de cluster
- Variables são resolvidas no **deploy**. Use **job parameters** para valores que mudam a cada execução
- Substituições nativas: `${bundle.name}`, `${bundle.target}` (use esta, não a antiga `${bundle.environment}`), `${workspace.current_user.userName}`, `${resources.jobs.<nome>.id}`

> [!tip] Segredos no CI
> Nunca escreva senhas no `databricks.yml` ou em notebooks. Declare uma variável sem default e faça o runner de CI exportar `BUNDLE_VAR_<nome>` a partir do seu cofre de segredos, para que o valor nunca toque o Git. Para credenciais em runtime, notebooks podem ler Databricks secrets com `dbutils.secrets.get`.

**Target overrides** não se limitam a variáveis. Qualquer mapeamento de nível superior (host do workspace, `run_as`, permissões ou configurações de recursos como tamanho de cluster ou agenda) pode ser sobrescrito por target, então os mesmos `resources/*.yml` servem todos os ambientes.

## Modos de deploy

| | `mode: development` | `mode: production` |
| :--- | :--- | :--- |
| Nomes dos recursos | Prefixo `[dev ${workspace.current_user.short_name}]` e tag `dev` | Inalterados |
| Agendas e triggers | **Pausados** nos recursos implantados | Ativos |
| Execuções concorrentes | Habilitadas, para iteração rápida | Conforme configurado |
| Pipelines | Marcados `development: true` | Validados como `development: false` |
| Override de cluster | `--cluster-id` / `cluster_id` permitido | **Não permitido** |
| Branch Git | — | Deve bater com a branch configurada no target (contorne com `--force`) |
| Identidade | Quem fez o deploy | Service principal recomendado. Validações checam `run_as`, `permissions` e se os caminhos não são específicos de usuário |
| Lock de deploy | Desabilitado | Habilitado |

**Presets** personalizam o comportamento do target além dos padrões do modo, por exemplo prefixo de nome, status de pausa dos triggers ou concorrência de jobs. Configurações individuais de recursos sobrescrevem presets. Fonte: [Deployment modes](https://docs.databricks.com/aws/en/dev-tools/bundles/deployment-modes).

## A CLI `databricks bundle`

| Comando | Propósito |
| :--- | :--- |
| `databricks bundle init` | "Inicializa um novo bundle a partir de um template" |
| `databricks bundle validate` | "Valida se os arquivos de configuração do bundle estão sintaticamente corretos" |
| `databricks bundle plan` | "Mostra o plano de deploy para a configuração atual" |
| `databricks bundle deploy -t <target>` | "Implanta um bundle no workspace remoto" |
| `databricks bundle run <recurso> -t <target>` | "Roda um job, pipeline, app ou script" |
| `databricks bundle summary` | Resume a identidade do bundle e os recursos implantados, com links para o workspace |
| `databricks bundle generate` | Gera YAML de bundle para um recurso que já existe no workspace |
| `databricks bundle deployment bind` / `unbind` | Liga um recurso do bundle a um recurso existente no workspace, ou remove essa ligação |
| `databricks bundle destroy` | "Apaga jobs, pipelines, outros recursos e artefatos implantados anteriormente" |

Flags globais: `-t, --target` escolhe o target, e `--var="chave=valor"` define variáveis. Fonte: [bundle command group](https://docs.databricks.com/aws/en/dev-tools/cli/bundle-commands).

## Um pipeline de CI/CD com bundles

```yaml
# .github/workflows/deploy.yml (esboço, baseado na página de GitHub Actions da documentação)
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      DATABRICKS_HOST: ${{ secrets.PROD_HOST }}
      DATABRICKS_CLIENT_ID: ${{ secrets.SP_CLIENT_ID }}          # OAuth de service principal
      DATABRICKS_CLIENT_SECRET: ${{ secrets.SP_CLIENT_SECRET }}
      BUNDLE_VAR_db_password: ${{ secrets.DB_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - uses: databricks/setup-cli@main
      - run: databricks bundle validate -t prod
      - run: databricks bundle deploy -t prod
      - run: databricks bundle run orders_job -t prod
```

1. **Branch de feature** → `databricks bundle deploy -t dev` (cópia pessoal, com prefixo e pausada)
2. **PR mesclado na `main`** → o CI roda `validate`, depois `deploy -t test` e testes de integração
3. **Release** → o CI roda `deploy -t prod` como **service principal**. O mesmo YAML é usado, com target overrides fornecendo os valores de prod

## Casos de uso

- **Promover um pipeline entre três workspaces** com overrides de `catalog` e `host` por target
- **Segredos vindos do CI**: `BUNDLE_VAR_db_password` injetado do cofre de segredos do CI no deploy
- **Adotar jobs existentes**: `bundle generate` transforma um job criado pela UI em YAML, e `deployment bind` faz a ligação
- **Ingestão do Lakeflow Connect como código**: ingestion pipelines são implantados com bundles como qualquer outro pipeline

## Problemas e erros comuns

### Senha commitada no `databricks.yml`

**Cenário:** um revisor encontra uma senha de banco no default de uma variável do bundle.
**Correção:** remova o default, troque a senha e forneça-a via `BUNDLE_VAR_<nome>` a partir dos secrets do CI, ou leia em runtime com `dbutils.secrets.get`.

### Deploy de produção rejeitado

**Cenário:** `databricks bundle deploy -t prod` falha na validação.
**Correção:** o modo production verifica a branch Git, `run_as`/permissões e caminhos específicos de usuário. Faça o deploy a partir da branch configurada, como service principal, com `root_path` compartilhado.

### Agendas do deploy de dev nunca disparam

**Cenário:** um job implantado com `-t dev` nunca roda na agenda.
**Correção:** o modo development pausa agendas e triggers por design. Rode com `databricks bundle run`, ou despause explicitamente em dev.

### Ambiente errado implantado

**Cenário:** `databricks bundle deploy` sem `-t` implanta em dev quando a intenção era prod.
**Correção:** sem `-t`, o bundle usa o target marcado com `default: true`. Sempre passe `-t` no CI.

### Valor da variável ignorado

**Cenário:** um target define `catalog: prod`, mas o deploy continua usando `dev`.
**Correção:** uma fonte de maior precedência está vencendo: uma flag `--var`, uma variável de ambiente `BUNDLE_VAR_catalog` ou o `variable-overrides.json`. Verifique essas primeiro.

## Dicas para a prova

> [!tip] Dicas para a prova
>
> - **Declarative Automation Bundles** = o antigo **Databricks Asset Bundles**. Mesma CLI (`databricks bundle`), mesmo `databricks.yml`
> - Segredos → variáveis de ambiente `BUNDLE_VAR_<nome>` (ou `--var`), nunca YAML commitado
> - Precedência de variáveis: `--var` > `BUNDLE_VAR_` > `variable-overrides.json` > `variables` do target > `default`
> - `mode: development` adiciona prefixo aos nomes e **pausa** agendas. `mode: production` valida branch, identidade e caminhos
> - `validate` checa a config, `deploy -t` implanta, `run` executa um job ou pipeline, `destroy` remove os recursos implantados

## Pontos-chave

- Bundles tornam jobs, pipelines e outros ativos versionados, revisáveis e repetíveis
- Targets mais variables e overrides promovem um código de dev para test e prod
- Deploys de produção rodam como service principal, a partir do CI, na branch de release
- A Databricks CLI (`databricks bundle ...`) é a interface de automação

## Tópicos relacionados

- [Git Folders](01-git-folders.md)
- [Lakeflow Jobs e Tasks](../04-working-with-lakeflow-jobs/01-lakeflow-jobs-and-tasks.md)

## Documentação oficial

- [Declarative Automation Bundles](https://docs.databricks.com/aws/en/dev-tools/bundles/)
- [Substitutions and variables](https://docs.databricks.com/aws/en/dev-tools/bundles/variables)
- [Deployment modes](https://docs.databricks.com/aws/en/dev-tools/bundles/deployment-modes)
- [bundle command group](https://docs.databricks.com/aws/en/dev-tools/cli/bundle-commands)
- [Bundles release notes](https://docs.databricks.com/aws/en/release-notes/dev-tools/bundles)
- [GitHub Actions for Databricks (Public Preview)](https://docs.databricks.com/aws/en/dev-tools/ci-cd/github)

---

**[← Anterior: Git Folders](01-git-folders.md) | [↑ Voltar para Implementing CI/CD](README.md)**
