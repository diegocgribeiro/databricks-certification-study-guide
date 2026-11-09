---
title: Row Filters, Column Masks e ABAC
type: study-material
tags:
  - data-engineer-associate
  - unity-catalog
  - row-filters
  - column-masks
  - abac
  - seguranca
status: published
---

# Row Filters, Column Masks e ABAC

## Visão geral

Privilégios decidem **se** um principal pode consultar uma tabela. O controle de acesso granular decide **quais linhas e quais valores de coluna** esse principal vê. O Unity Catalog oferece três ferramentas para isso. **Row filters** e **column masks** são SQL UDFs anexadas a uma tabela. **Dynamic views** são a abordagem clássica baseada em views. **Políticas de controle de acesso baseado em atributos (ABAC)** aplicam filtros e máscaras de forma centralizada, usando governed tags em um catálogo ou schema.

> [!abstract] Resumo
>
> - **Row filter**: uma SQL UDF que retorna `BOOLEAN`, anexada com `ALTER TABLE ... SET ROW FILTER fn ON (cols)`. Linhas para as quais ela retorna `FALSE` ficam ocultas
> - **Column mask**: uma SQL UDF que retorna o tipo da coluna, anexada com `ALTER TABLE ... ALTER COLUMN c SET MASK fn`. Cada coluna pode ter uma máscara
> - Condicione ambos ao grupo com **`is_account_group_member('grupo')`**
> - **ABAC**: `CREATE POLICY ... ROW FILTER | COLUMN MASK ... FOR TABLES WHEN has_tag_value(...)`, anexada no nível de catálogo, schema ou tabela. Donos de tabelas não podem sobrescrever políticas definidas por admins de nível superior

> [!tip] O que a prova cobra
>
> - Habilidade do exam guide: entender mascaramento por coluna e segurança por linha para restringir a visibilidade conforme o grupo do usuário
> - Habilidade do exam guide: entender políticas ABAC do Unity Catalog para controlar centralmente row filtering e column masking de dados sensíveis
> - Escrever uma máscara com `is_account_group_member(...)` para que só um grupo veja o valor real
> - Quando usar filtros/máscaras por tabela, dynamic views ou ABAC

---

## Column masks

```sql
-- 1. Função de máscara: finance vê o número completo do cartão, os demais veem só os 4 últimos dígitos
CREATE OR REPLACE FUNCTION main.security.mask_card(card STRING)
RETURNS STRING
RETURN CASE
  WHEN is_account_group_member('finance_team') THEN card
  ELSE concat('****-****-****-', right(card, 4))
END;

-- 2. Anexe à coluna
ALTER TABLE main.silver.payments
  ALTER COLUMN credit_card_number SET MASK main.security.mask_card;

-- 3. Remova
ALTER TABLE main.silver.payments ALTER COLUMN credit_card_number DROP MASK;
```

- A função recebe o valor da coluna e retorna o original ou um valor mascarado. O **tipo de retorno deve ser igual** ao da coluna, ou conversível para ele
- **Uma máscara por coluna**. Máscaras podem referenciar outras colunas

## Row filters

```sql
-- Usuários veem só as linhas da sua região; admins veem tudo
CREATE OR REPLACE FUNCTION main.security.region_filter(region STRING)
RETURNS BOOLEAN
RETURN is_account_group_member('admins')
    OR (is_account_group_member('emea_sales') AND region = 'EMEA')
    OR (is_account_group_member('amer_sales') AND region = 'AMER');

ALTER TABLE main.silver.orders SET ROW FILTER main.security.region_filter ON (region);

ALTER TABLE main.silver.orders DROP ROW FILTER;
```

Linhas para as quais a função retorna `FALSE` são excluídas dos resultados ([Row filters and column masks](https://docs.databricks.com/aws/en/tables/row-and-column-filters)).

### Requisitos e limitações (filtros e máscaras por tabela)

| Tópico | Detalhe |
| :--- | :--- |
| **Runtime** | DBR abaixo de 12.2 LTS não suporta, e **não retorna dados** em vez de liberar o acesso |
| **Access mode dedicated** | DBR 15.4 LTS+ com serverless habilitado no workspace (as consultas passam pelo fine-grained access control serverless). DBR 15.4–16.2 é só leitura; escritas exigem 16.3+ |
| **Views** | Você **não pode** aplicar row filters ou column masks a uma view |
| **Não suportado** | Time travel em tabelas com políticas por tabela. Deep ou shallow clones. OpenSharing dessas tabelas. Criar índice de AI Search a partir delas |
| **Quem gerencia** | O dono da tabela ou um usuário com `MANAGE` |

> [!note] Atualização da plataforma (out/2026)
> A documentação agora usa **AI Search** para o que os exam guides chamam de **Vector Search**, e **OpenSharing** para Delta Sharing (renomeado em 10/06/2026).

## Dynamic views

Antes de existirem filtros e máscaras por tabela, o padrão era uma **dynamic view**: uma view sobre a tabela base que filtra ou mascara com base no usuário que consulta, concedida aos consumidores no lugar da tabela base.

```sql
CREATE OR REPLACE VIEW main.gold.v_payments AS
SELECT payment_id,
       CASE WHEN is_account_group_member('finance_team') THEN credit_card_number
            ELSE '****' END AS credit_card_number,
       amount, region
FROM main.silver.payments
WHERE is_account_group_member('admins') OR region = 'EMEA';

GRANT SELECT ON main.gold.v_payments TO `analysts`;   -- analistas NÃO recebem SELECT na tabela base
```

Dynamic views ainda servem quando você compartilha uma **fatia curada ou transformada** dos dados, ou quando os consumidores nunca devem tocar na tabela base.

## Políticas ABAC

O controle de acesso baseado em atributos avalia **atributos (governed tags)** nos objetos. Uma política pode proteger toda tabela e coluna com as tags alvo, atuais e futuras, em um catálogo ou schema ([Unity Catalog ABAC](https://docs.databricks.com/aws/en/data-governance/unity-catalog/abac/)).

```sql
-- Marque os dados (governed tags precisam existir e ser aplicadas)
ALTER TABLE main.silver.customers ALTER COLUMN email SET TAGS ('pii' = 'email');

-- UDF de máscara
CREATE OR REPLACE FUNCTION main.security.mask_email(email STRING)
RETURNS STRING
RETURN concat('***@', split(email, '@')[1]);

-- Uma política mascara toda coluna de email marcada no schema para os analistas
CREATE POLICY mask_pii_email
ON SCHEMA main.silver
COMMENT 'Mascara emails para analistas'
COLUMN MASK main.security.mask_email
TO `analysts`
EXCEPT `privacy_admins`
FOR TABLES
MATCH COLUMNS has_tag_value('pii', 'email') AS email
ON COLUMN email;

-- Política de row filter em tabelas marcadas com sensitivity = high
CREATE POLICY us_rows_only
ON CATALOG main
ROW FILTER main.security.us_only
TO `contractors`
FOR TABLES
WHEN has_tag_value('sensitivity', 'high')
MATCH COLUMNS has_tag('region') AS region
USING COLUMNS (region);
```

Gramática da política: `CREATE [OR REPLACE] POLICY nome ON { METASTORE | CATALOG c | SCHEMA s | TABLE t } { ROW FILTER fn | COLUMN MASK fn } TO principals [EXCEPT principals] FOR TABLES [WHEN condição] [MATCH COLUMNS condição AS alias] [ON COLUMN alias] [USING COLUMNS (...)]`.

| Aspecto | Detalhe |
| :--- | :--- |
| **Anexar em** | Catálogo, schema ou tabela. Nível de metastore é Beta |
| **Alvos** | Objetos cujas **governed tags** batem com `WHEN` / `MATCH COLUMNS` (`has_tag`, `has_tag_value`) |
| **Requisitos** | DBR **16.4+ ou serverless**. `MANAGE` (ou propriedade) no objeto onde a política é anexada. `EXECUTE` na UDF |
| **Sobrescrever** | Definidas por admins de nível superior, então **donos de tabelas não podem sobrescrever nem remover** |
| **Outros tipos de política** | GRANT policies (Beta) e DENY policies (Beta, que negam `MANAGE ACCESS CONTROL`) |

## Escolhendo uma abordagem

| Necessidade | Use |
| :--- | :--- |
| Mascarar ou filtrar uma tabela específica | **Column mask** ou **row filter** por tabela |
| Regras consistentes em muitas tabelas que têm o mesmo atributo sensível | **Política ABAC** no catálogo ou schema, aplicada por governed tags. A documentação recomenda para escala |
| Compartilhar uma fatia curada e transformada, ocultando a tabela base | **Dynamic view** |
| Esconder uma tabela inteira de um grupo | Não conceda `SELECT`. Filtro ou máscara não são necessários |

## Casos de uso

- **PCI**: só `finance_team` vê os números completos dos cartões. Os demais veem os quatro últimos dígitos
- **Vendas regionais**: cada grupo de vendas vê só os pedidos da sua região por meio de um row filter
- **Programa corporativo de PII**: o time de privacidade marca as colunas de PII uma vez, e uma política ABAC as mascara em todos os schemas
- **Extração para parceiros**: uma dynamic view expõe um subconjunto agregado e mascarado

## Problemas e erros comuns

### Função de máscara rejeitada

**Cenário:** `SET MASK` falha porque a função retorna `STRING` mas a coluna é `DECIMAL`.
**Correção:** o tipo de retorno da máscara deve ser igual ao da coluna, ou conversível para ele.

### Usuários num runtime antigo não veem linhas

**Cenário:** um time no DBR 11.3 recebe resultados vazios de uma tabela com filtro.
**Correção:** runtimes abaixo de 12.2 LTS não suportam row filters ou máscaras, e não retornam dados em vez de liberar o acesso. Atualize, ou use serverless ou um SQL warehouse.

### Time travel falha numa tabela mascarada

**Cenário:** `SELECT ... VERSION AS OF 3` falha depois que um row filter foi adicionado.
**Correção:** time travel não é suportado com políticas por tabela. Planeje auditorias sobre os dados atuais, ou mantenha um histórico governado separado.

### Dono da tabela não consegue remover uma máscara

**Cenário:** o dono de uma tabela tenta remover uma regra de máscara em uma coluna de email e não consegue.
**Correção:** a máscara vem de uma política ABAC anexada no schema ou catálogo, então só um admin com `MANAGE` ali pode alterá-la.

## Dicas para a prova

> [!tip] Dicas para a prova
>
> - "Só o grupo X vê o valor completo" → UDF de **column mask** com `is_account_group_member('X')`
> - "Usuários veem só suas linhas" → UDF de **row filter** que retorna `BOOLEAN`, anexada com `SET ROW FILTER ... ON (cols)`
> - `DENY` numa coluna não é a forma como o Unity Catalog mascara dados (e o `DENY` clássico é só Hive metastore)
> - **ABAC** = `CREATE POLICY` + governed tags no nível de catálogo ou schema, aplicadas de forma consistente a muitas tabelas
> - Filtros e máscaras não podem ser aplicados a views. Use uma dynamic view

## Pontos-chave

- Row filters e column masks são SQL UDFs anexadas a tabelas e avaliadas em toda consulta
- `is_account_group_member()` liga a visibilidade a grupos no nível da conta
- ABAC escala os mesmos controles em catálogos e schemas via governed tags
- Dynamic views continuam úteis para fatias curadas e compartilháveis

## Tópicos relacionados

- [Controle de acesso e permissões](03-access-control-permissions.md)
- [Managed e External Tables](02-managed-and-external-tables.md)
- [Compartilhamento de dados](05-data-sharing.md)

## Documentação oficial

- [Row filters and column masks](https://docs.databricks.com/aws/en/tables/row-and-column-filters)
- [Unity Catalog attribute-based access control (ABAC)](https://docs.databricks.com/aws/en/data-governance/unity-catalog/abac/)
- [Create and manage ABAC policies](https://docs.databricks.com/aws/en/data-governance/unity-catalog/abac/policies)
- [ABAC DENY policies (Beta)](https://docs.databricks.com/aws/en/data-governance/unity-catalog/abac/deny-policies)

---

**[← Anterior: Controle de acesso e permissões](03-access-control-permissions.md) | [↑ Voltar para Governance and Security](README.md) | [Próximo: Compartilhamento de dados →](05-data-sharing.md)**
