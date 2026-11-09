---
title: Managed e External Tables
type: study-material
tags:
  - data-engineer-associate
  - unity-catalog
  - managed-tables
  - external-tables
  - governanca
status: published
---

# Managed e External Tables

## Visão geral

O Unity Catalog tem dois tipos de tabela com ciclos de vida bem diferentes. Numa tabela **managed**, o Unity Catalog é dono do armazenamento, do layout e da otimização dos dados. Numa tabela **external**, o Unity Catalog governa os metadados enquanto os arquivos ficam em um caminho que você controla. O exam guide espera que você diferencie as duas e saiba **criar, modificar, apagar e converter** entre elas, incluindo os comandos mais novos `SET MANAGED` e `UNSET MANAGED`.

> [!abstract] Resumo
>
> - **Managed** (padrão, recomendada): criada sem `LOCATION`. Os dados ficam no managed storage do schema ou catálogo. Elegível para predictive optimization e liquid clustering automático
> - **External**: criada com `LOCATION` em um caminho coberto por uma **external location** do UC. `DROP TABLE` remove só os metadados; os arquivos permanecem
> - Managed tables removidas podem ser recuperadas com **`UNDROP TABLE` por 7 dias** (padrão); depois disso os arquivos são apagados
> - Converta external → managed com **`ALTER TABLE ... SET MANAGED`** (DBR 17.3 LTS+ ou serverless). Desfaça em até **14 dias** com **`ALTER TABLE ... UNSET MANAGED`**

> [!tip] O que a prova cobra
>
> - Habilidade do exam guide: diferenciar managed e external tables no Unity Catalog e fazer operações básicas (criar, modificar, apagar e converter entre elas)
> - O que o `DROP TABLE` faz com os dados em cada tipo
> - Privilégios para criar external tables (`CREATE EXTERNAL TABLE` na external location)
> - Comandos de conversão e rollback, suas janelas e efeitos colaterais (streams reiniciam, time travel só por versão)

---

## Lado a lado

| | Managed table | External table |
| :--- | :--- | :--- |
| Criar | `CREATE TABLE c.s.t (...)` (sem `LOCATION`) | `CREATE TABLE c.s.t (...) LOCATION 's3://...'` |
| Local dos dados | Managed storage do schema ou catálogo | Um caminho que você escolhe, dentro de uma external location do UC |
| Formatos | Delta (padrão) ou Iceberg (`USING iceberg`) | DELTA, CSV, JSON, AVRO, PARQUET, ORC, TEXT |
| Quem gerencia layout e otimização | Unity Catalog (predictive optimization, liquid clustering automático) | Você |
| `DROP TABLE` | Metadados removidos. Dados recuperáveis com `UNDROP` por 7 dias (configurável: 0 h ou 7–30 dias), depois apagados | **Só metadados**. "O Unity Catalog não apaga os dados no cloud storage" |
| Recomendação da Databricks | **Padrão e recomendada** na maioria dos casos | Dados existentes incompatíveis com managed tables, ou clientes externos que precisam de acesso direto aos arquivos |

Fontes: [Unity Catalog managed tables](https://docs.databricks.com/aws/en/tables/managed), [Work with external tables](https://docs.databricks.com/aws/en/tables/external).

## Criar

```sql
-- Managed (Delta por padrão)
CREATE TABLE main.silver.customers (
  customer_id BIGINT NOT NULL,
  email STRING,
  country STRING
);

-- Managed a partir de uma consulta
CREATE TABLE main.gold.revenue AS
SELECT region, SUM(amount) AS revenue FROM main.silver.orders GROUP BY region;

-- External: os dados ficam em um caminho governado
CREATE TABLE main.bronze.vendor_feed (
  id BIGINT, payload STRING
)
LOCATION 's3://acme-landing/vendor_feed/';
```

```python
# External table a partir de uma escrita de DataFrame (opção path)
(df.write
   .option("path", "s3://acme-landing/vendor_feed/")
   .saveAsTable("main.bronze.vendor_feed"))
```

**Privilégios para external table**: `CREATE EXTERNAL TABLE` em uma external location que cubra o caminho, mais `USE CATALOG`, `USE SCHEMA` e `CREATE TABLE` nos pais. Managed tables precisam de `USE CATALOG`, `USE SCHEMA` e `CREATE TABLE`.

## Modificar

```sql
ALTER TABLE main.silver.customers ADD COLUMN signup_date DATE;
ALTER TABLE main.silver.customers RENAME COLUMN email TO email_address;    -- pode exigir column mapping
ALTER TABLE main.silver.customers SET TBLPROPERTIES ('contains_pii' = 'true');
ALTER TABLE main.silver.customers OWNER TO `data-platform-admins`;
COMMENT ON TABLE main.silver.customers IS 'Cadastro de clientes deduplicado';

-- External tables: se os metadados mudaram fora do Unity Catalog, ressincronize
MSCK REPAIR TABLE main.bronze.vendor_feed SYNC METADATA;
```

## Apagar e recuperar

```sql
DROP TABLE main.silver.customers;            -- managed: recuperável durante o período de recuperação
UNDROP TABLE main.silver.customers;          -- em até 7 dias por padrão

DROP TABLE main.bronze.vendor_feed;          -- external: os arquivos continuam no LOCATION
-- Para remover os dados também, apague os arquivos no cloud storage você mesmo
```

Apagar exige ser dono ou ter `MANAGE` na tabela. O período de recuperação de managed tables pode ser definido por catálogo ou schema (Public Preview): 0 horas (sem recuperação) ou 7–30 dias.

## Converter external → managed (`SET MANAGED`)

```sql
ALTER TABLE main.bronze.vendor_feed SET MANAGED;

-- Se a external table tiver leituras Iceberg (UniForm) habilitadas:
ALTER TABLE main.bronze.vendor_feed SET MANAGED TRUNCATE UNIFORM HISTORY;
```

| Aspecto | O que a documentação diz |
| :--- | :--- |
| **Requisitos** | Databricks Runtime **17.3 LTS+ ou serverless**. A tabela precisa ser Delta e você precisa ser o **dono**. Leitores e escritores devem estar no DBR 15.4 LTS+ |
| **O que é mantido** | Nome, configurações, permissões, views e histórico da tabela |
| **Como funciona** | Etapa 1 copia os dados e o transaction log para o managed storage, sem downtime. Etapa 2 traz os commits feitos durante a cópia e atualiza os metadados. Escritores ficam bloqueados por pouco tempo (~1–5 minutos, conforme o tamanho) |
| **Streams** | Streams de leitura e escrita existentes **falham** após a conversão. Reinicie-os com a mesma configuração |
| **Time travel** | No DBR 15.3 ou anterior, após a conversão só dá para fazer time travel **por versão**, não por timestamp |
| **Antes de começar** | Cancele jobs de `OPTIMIZE` em execução e não agende novos durante a conversão |

## Desfazer managed → external (`UNSET MANAGED`)

```sql
ALTER TABLE main.bronze.vendor_feed UNSET MANAGED;
```

- Disponível **em até 14 dias** após a conversão. A Databricks guarda os dados de origem por 14 dias para permitir o rollback
- "Atualiza os metadados da tabela para apontar de volta para a external location original", e escritas feitas no local gerenciado após a conversão são preservadas
- Commits feitos entre a conversão e o rollback suportam time travel **por versão, mas não por timestamp**
- **Sete dias após o rollback**, a Databricks apaga automaticamente os dados no local gerenciado
- Reinicie os streams depois do rollback também. Confirme verificando que o tipo da tabela é `EXTERNAL`

Fonte: [Convert external or foreign tables to managed tables](https://docs.databricks.com/aws/en/tables/convert-external-managed).

> [!warning] Erro comum
> `RESTORE TABLE ... VERSION AS OF` restaura **versões de dados**. Não muda o **tipo** da tabela. Para desfazer um `SET MANAGED`, use `UNSET MANAGED` dentro da janela de 14 dias. Não é preciso apagar e recriar a tabela.

## Casos de uso

- **Silver e Gold novas**: crie managed tables para ganhar predictive optimization e clustering automático
- **Pastas existentes do data lake**: registre como external tables primeiro e depois `SET MANAGED` quando nada mais escrever direto no caminho
- **Drop acidental**: `UNDROP TABLE` restaura uma managed table dentro do período de recuperação
- **Dados que engines externas escrevem diretamente**: mantenha external, porque escritas diretas no caminho passam por fora da governança do UC

## Problemas e erros comuns

### Os dados continuam lá depois do DROP

**Cenário:** depois de `DROP TABLE`, os arquivos ainda existem no S3.
**Correção:** a tabela era external, então o `DROP` removeu só os metadados. Apague os arquivos você mesmo se precisarem ser removidos.

### Os dados sumiram depois do DROP

**Cenário:** uma managed table foi apagada por engano.
**Correção:** rode `UNDROP TABLE` dentro do período de recuperação (7 dias por padrão). Depois disso, os arquivos são apagados.

### Permissão negada em `CREATE TABLE ... LOCATION`

**Cenário:** um engenheiro consegue criar managed tables, mas recebe erro de permissão com `LOCATION`.
**Correção:** external tables exigem `CREATE EXTERNAL TABLE` em uma external location que cubra o caminho.

### Streams falham logo após a conversão

**Cenário:** depois de `SET MANAGED`, um job de streaming que lê a tabela dá erro.
**Correção:** é o comportamento esperado. Reinicie os streams com a mesma configuração.

## Dicas para a prova

> [!tip] Dicas para a prova
>
> - **Managed** = o UC é dono dos dados. O `DROP` os apaga depois da janela do `UNDROP`. **External** = `DROP` remove só os metadados
> - Managed tables são o tipo **padrão e recomendado**, e o único em que o predictive optimization roda
> - External → managed: `ALTER TABLE ... SET MANAGED`. Desfazer: `ALTER TABLE ... UNSET MANAGED` **em até 14 dias**
> - `RESTORE` restaura versões de dados. Não reverte uma conversão de tipo
> - External tables precisam de `CREATE EXTERNAL TABLE` em uma **external location**

## Pontos-chave

- Os dois tipos diferem em quem é dono do storage, do layout e do ciclo de vida dos dados
- `UNDROP` recupera managed tables apagadas dentro do período de recuperação
- `SET MANAGED` / `UNSET MANAGED` convertem nos dois sentidos, com janelas e efeitos colaterais documentados
- Prefira managed tables. Mantenha external tables para dados que precisam ficar em um caminho onde outras engines escrevem

## Tópicos relacionados

- [Unity Catalog Básico](01-unity-catalog-basics.md)
- [Controle de acesso e permissões](03-access-control-permissions.md)
- [Liquid Clustering e Predictive Optimization](../06-troubleshooting-monitoring-and-optimization/04-liquid-clustering-and-predictive-optimization.md)
- [Fundamentos do Delta Lake](../01-databricks-intelligence-platform/04-delta-lake-fundamentals.md)

## Documentação oficial

- [Unity Catalog managed tables](https://docs.databricks.com/aws/en/tables/managed)
- [Work with external tables](https://docs.databricks.com/aws/en/tables/external)
- [Convert external or foreign tables to managed tables](https://docs.databricks.com/aws/en/tables/convert-external-managed)

---

**[← Anterior: Unity Catalog Básico](01-unity-catalog-basics.md) | [↑ Voltar para Governance and Security](README.md) | [Próximo: Controle de acesso e permissões →](03-access-control-permissions.md)**
