---
title: Transformações Avançadas
type: study-material
tags:
  - udfs
  - window-functions
  - avancado
---

# Transformações Avançadas

## Visão geral

Técnicas avançadas de transformação permitem processamentos complexos que vão além das operações SQL padrão. User-defined functions (UDFs), window functions e operações com coleções dão flexibilidade para pipelines sofisticados.

> [!abstract] Resumo
>
> - Funções de coleção: `explode`, `split`, `array_contains`, `transform`, `filter`, `flatten`
> - Window functions (`ROW_NUMBER`, `RANK`, `LAG`) para ranking, deduplicação e totais acumulados
> - Prefira funções nativas a UDFs Python. UDFs são opacas para o otimizador e adicionam custo de serialização

> [!tip] O que a prova cobra
>
> - Habilidade do exam guide: manipular colunas e linhas: split de strings, explode de arrays, renomear, filtrar
> - Habilidade do exam guide: limpeza Bronze → Silver, incluindo tratamento de nulos e padronização de tipos
> - Escolher uma higher-order function (`filter`, `transform`) em vez de `explode` + `groupBy`

---

## User-Defined Functions (UDFs)

### UDFs Python

```python
from pyspark.sql.functions import udf, col
from pyspark.sql.types import StringType

def categorize_salary(salary):
    if salary < 50000:
        return "Entry"
    elif salary < 100000:
        return "Mid"
    else:
        return "Senior"

categorize_udf = udf(categorize_salary, StringType())

df_categorized = employees.withColumn("level", categorize_udf(col("salary")))
```

### Pandas UDFs (vetorizadas)

Pandas UDFs são mais rápidas que UDFs Python comuns porque operam em **lotes** (via Apache Arrow):

```python
from pyspark.sql.functions import pandas_udf
import pandas as pd

@pandas_udf("string")
def categorize_salary_pandas(salary_series: pd.Series) -> pd.Series:
    """UDF vetorizada - processa o lote inteiro de uma vez"""
    return pd.cut(
        salary_series,
        bins=[0, 50000, 100000, float('inf')],
        labels=['Entry', 'Mid', 'Senior']
    ).astype(str)

df_categorized = employees.withColumn("level", categorize_salary_pandas(col("salary")))
```

### Registrando UDF para uso em SQL

```python
spark.udf.register("categorize_salary_sql", categorize_salary, StringType())

result = spark.sql("""
    SELECT id, name, salary, categorize_salary_sql(salary) as level
    FROM employees
""")
```

### SQL UDFs no Unity Catalog

```sql
CREATE FUNCTION main.default.salary_level(salary DOUBLE)
RETURNS STRING
RETURN CASE WHEN salary < 50000 THEN 'Entry'
            WHEN salary < 100000 THEN 'Mid'
            ELSE 'Senior' END;

SELECT main.default.salary_level(salary) FROM employees;
```

## Window functions

```mermaid
flowchart LR
    Data["Dados de entrada<br/>Linhas com valores"]
    Window["Especificação da janela<br/>PARTITION BY + ORDER BY"]
    Compute["Cálculo sobre<br/>o frame da janela"]
    Result["Resultado<br/>Novas colunas"]

    Data --> Window
    Window --> Compute
    Compute --> Result
```

### Sintaxe

```sql
SELECT
    name,
    department,
    salary,
    -- Ranking
    ROW_NUMBER() OVER (PARTITION BY department ORDER BY salary DESC) as row_num,
    RANK()       OVER (PARTITION BY department ORDER BY salary DESC) as rank,
    DENSE_RANK() OVER (PARTITION BY department ORDER BY salary DESC) as dense_rank,

    -- Agregações sobre a janela
    AVG(salary) OVER (PARTITION BY department) as dept_avg,
    SUM(salary) OVER (PARTITION BY department) as dept_total,

    -- Lead/Lag
    LAG(salary)  OVER (ORDER BY hire_date) as prev_salary,
    LEAD(salary) OVER (ORDER BY hire_date) as next_salary
FROM employees
```

### Em Python

```python
from pyspark.sql import functions as F
from pyspark.sql.window import Window

window_dept = Window.partitionBy("department").orderBy(F.desc("salary"))

df_windowed = (employees
    .withColumn("row_num", F.row_number().over(window_dept))
    .withColumn("rank", F.rank().over(window_dept))
    .withColumn("dense_rank", F.dense_rank().over(window_dept))
    .withColumn("dept_avg", F.avg("salary").over(Window.partitionBy("department"))))
```

### Deduplicação com ROW_NUMBER (padrão muito cobrado)

```python
# Manter apenas o registro MAIS RECENTE de cada customer_id
w = Window.partitionBy("customer_id").orderBy(F.col("updated_at").desc())

latest = (df
    .withColumn("rn", F.row_number().over(w))
    .filter("rn = 1")
    .drop("rn"))
```

### Window functions comuns

| Função | Propósito | Exemplo |
|----------|---------|---------|
| `ROW_NUMBER()` | Número único da linha na janela | `1, 2, 3, ...` |
| `RANK()` | Ranking com lacunas em empates | `1, 1, 3, ...` |
| `DENSE_RANK()` | Ranking sem lacunas | `1, 1, 2, ...` |
| `LAG()` | Valor da linha anterior | Salário anterior |
| `LEAD()` | Valor da próxima linha | Próximo salário |
| `FIRST_VALUE()` | Primeiro valor da janela | Primeiro salário da partição |
| `LAST_VALUE()` | Último valor da janela | Último salário da partição |
| `NTH_VALUE()` | N-ésimo valor da janela | 3º maior salário |

## Funções de coleção

### Arrays

```python
from pyspark.sql.functions import array, array_contains, split, explode, explode_outer, size

# Criar array
df_array = employees.select(col("name"), array(col("first_name"), col("last_name")).alias("name_parts"))

# Operações com array
df_array = employees.select(
    col("skills"),
    array_contains(col("skills"), "Python").alias("knows_python"),
    size(col("skills")).alias("num_skills")
)

# split: string -> array
df = df.withColumn("tags", split(col("tags_csv"), ","))

# explode: um elemento do array por linha (linhas com array NULL/vazio somem)
df_exploded = employees.selectExpr("name", "explode(skills) as skill")

# explode_outer: mantém linhas com array NULL/vazio (gera NULL)
df_kept = employees.select("name", explode_outer("skills").alias("skill"))

# Juntar array a partir de GROUP BY
df_collected = employees.groupBy("department").agg(F.collect_list("name").alias("employees"))
```

### Higher-order functions (sem explode)

```sql
SELECT
  order_id,
  filter(items, x -> x.qty > 0)            AS valid_items,   -- filtra elementos
  transform(items, x -> x.price * x.qty)   AS line_totals,   -- mapeia elementos
  exists(items, x -> x.sku = 'A1')         AS has_a1,
  aggregate(items, 0D, (acc, x) -> acc + x.price * x.qty) AS order_total,
  flatten(array_of_arrays)                 AS flat
FROM orders;
```

Elas operam dentro do array, sem explodir e reagrupar — mais simples e mais eficiente.

### Maps

```python
from pyspark.sql.functions import create_map, lit, map_keys, map_values

df_map = employees.select(
    col("name"),
    create_map(lit("salary"), col("salary"), lit("department"), col("department")).alias("info")
)

df_accessed = df_map.withColumn("dept", col("info")["department"])

# Explodir map em linhas chave-valor
df_exploded = df_map.selectExpr("name", "explode(info) as (key, value)")
```

### Structs

```python
from pyspark.sql.functions import struct

df_struct = employees.select(
    col("name"),
    struct(
        col("name").alias("full_name"),
        col("salary").alias("annual_salary"),
        col("department").alias("dept")
    ).alias("employee_info")
)

# Acessar campos do struct (notação de ponto)
df_accessed = df_struct.withColumn("emp_name", col("employee_info.full_name"))

# Expandir todos os campos
df_flat = df_struct.select("name", "employee_info.*")
```

## Operações com strings

```python
from pyspark.sql.functions import lower, upper, trim, substring, concat, concat_ws, length, regexp_replace

df_strings = employees.select(
    lower(col("name")).alias("name_lower"),
    upper(col("department")).alias("dept_upper"),
    trim(col("email")).alias("email_clean"),
    substring(col("name"), 1, 3).alias("name_prefix"),
    concat(col("first_name"), lit(" "), col("last_name")).alias("full_name"),
    concat_ws(" ", "first_name", "last_name").alias("full_name2"),
    regexp_replace(col("phone"), "[^0-9]", "").alias("phone_digits"),
    length(col("name")).alias("name_length")
)
```

## Datas e timestamps

```python
from pyspark.sql.functions import current_date, year, month, dayofmonth, datediff, date_add, from_unixtime, to_date, to_timestamp

df_dates = employees.select(
    year(col("hire_date")).alias("hire_year"),
    month(col("hire_date")).alias("hire_month"),
    dayofmonth(col("hire_date")).alias("hire_day"),
    datediff(current_date(), col("hire_date")).alias("days_employed"),
    date_add(col("hire_date"), 365).alias("one_year_anniversary"),
    from_unixtime(col("timestamp_ms") / 1000).alias("readable_timestamp"),
    to_date(col("date_str"), "dd/MM/yyyy").alias("parsed_date")
)
```

## Lógica condicional

```python
from pyspark.sql.functions import when, coalesce

df_conditional = employees.withColumn(
    "bonus_eligible", when(col("salary") > 100000, True).otherwise(False))

df_bonus = employees.withColumn("bonus_pct",
    when(col("salary") >= 150000, 0.20)
    .when(col("salary") >= 100000, 0.15)
    .when(col("salary") >= 50000, 0.10)
    .otherwise(0.05))

# coalesce: primeiro valor não nulo
df_coalesce = employees.withColumn(
    "contact", coalesce(col("email"), col("phone"), lit("Sem contato")))
```

## Achatando estruturas aninhadas

```python
df_unnested = (employees
    .select("id", "name", F.explode("addresses").alias("address"))
    .select("id", "name", "address.street", "address.city"))

df_flattened = employees.select(
    "id", "name",
    col("contact_info.email").alias("email"),
    col("contact_info.phone").alias("phone"))
```

## Pivot

```sql
SELECT *
FROM employees
PIVOT (
    SUM(salary)
    FOR department IN ('Engineering' as eng, 'Sales' as sales, 'HR' as hr)
)
```

```python
df_pivoted = (employees
    .groupBy("year")
    .pivot("department", ["Engineering", "Sales", "HR"])
    .agg(F.sum("salary")))
```

## Tratamento de nulos

```python
from pyspark.sql.functions import isnan, isnull

df_nulls = employees.select(
    col("name"),
    isnull(col("email")).alias("email_missing"),
    isnan(col("salary")).alias("salary_invalid"))

# Remover linhas com nulo
df_clean = employees.dropna(subset=["email"])

# Preencher nulos
df_filled = employees.fillna({"email": "unknown@company.com", "department": "Unassigned"})

# Forward fill (último valor não nulo)
window_fill = Window.orderBy(col("hire_date"))
df_forward_filled = employees.withColumn(
    "salary",
    F.last(col("salary"), ignorenulls=True).over(
        window_fill.rowsBetween(Window.unboundedPreceding, 0)))
```

## Considerações de performance

### Broadcast vs shuffle

```python
from pyspark.sql.functions import broadcast

result = large_df.join(broadcast(small_reference), large_df.key == small_reference.key)  # sem shuffle do lado grande
result = df1.join(df2, df1.key == df2.key)  # grande com grande: shuffle
```

### Estratégia de cache

```python
df_cleaned = df.filter(col("sales") > 100)
df_cleaned.cache()

result1 = df_cleaned.select("name", "sales")
result2 = df_cleaned.filter(col("sales") > 500)

df_cleaned.unpersist()
```

## UDF vs funções nativas

| Aspecto | Nativa | UDF |
|--------|----------|-----|
| **Performance** | Rápida (otimizada) | Mais lenta |
| **Flexibilidade** | Limitada | Ilimitada |
| **Otimização** | O Catalyst otimiza | Otimização limitada |
| **Quando usar** | Sempre prefira | Último recurso |

## Casos de uso

- **Achatar payloads JSON aninhados**: usar `explode()`, `from_json()` e acesso a structs para transformar respostas de APIs ou logs de eventos em tabelas Delta planas e consultáveis.
- **Lógica de negócio customizada via UDFs**: aplicar UDFs Python ou Pandas para transformações específicas (parsing de endereço, scores customizados) que não dá para expressar com funções nativas.

## Problemas e erros comuns

### UDF Python deixa um job Silver lento

**Cenário:** uma UDF Python que converte para minúsculas e remove espaços deixa um job Silver várias vezes mais lento.
**Correção:** use funções nativas (`lower`, `trim`, `regexp_replace`). O otimizador não enxerga dentro de UDFs Python, e cada linha é serializada para Python. Se a UDF for inevitável, use uma pandas UDF vetorizada.

### Erros de serialização em UDF

**Cenário:** uma UDF Python falha com `PicklingError` porque referencia um objeto não serializável (ex.: conexão de banco ou logger).
**Correção:** use Pandas UDFs ou funções nativas. Se precisar de UDF customizada, garanta que os objetos referenciados sejam serializáveis ou instancie-os dentro da função.

### Schema inconsistente ao explodir dados aninhados

**Cenário:** `explode()` em uma coluna derivada de JSON falha com `AnalysisException` porque o schema inferido de `ArrayType` ou `MapType` varia entre linhas.
**Correção:** use `from_json()` com schema explícito antes de explodir.

## Dicas para a prova

- Sempre prefira funções nativas do Spark a UDFs; UDFs escapam do Catalyst e são mais lentas
- Pandas UDFs (vetorizadas) são bem mais rápidas que UDFs Python comuns porque processam lotes
- Saiba a diferença entre `ROW_NUMBER()`, `RANK()` e `DENSE_RANK()` — principalmente em empates
- `explode()` transforma uma coluna array em várias linhas; padrão comum na prova. `explode_outer()` mantém linhas com array nulo

## Pontos-chave

- **UDF**: funções definidas pelo usuário; Pandas UDFs são mais rápidas que UDFs Python
- **Window functions**: calculam valores sobre partições sem colapsar linhas
- **Coleções**: arrays, maps e structs para tipos complexos
- **String/Data**: funções padrão para texto e tempo
- **Condicionais**: when/otherwise para lógica de negócio
- **Nulos**: fillna/dropna/coalesce para qualidade de dados
- **Otimização**: broadcast para tabelas pequenas, evite UDFs quando possível
- **Pivot**: transforma linhas em colunas

## Tópicos relacionados

- [Joins e Agregações](03-joins-aggregations.md)
- [Limpeza e Qualidade de Dados](05-data-cleaning-and-quality.md)

## Documentação oficial

- [PySpark Built-in Functions](https://docs.databricks.com/en/pyspark/index.html)
- [Window Functions](https://docs.databricks.com/en/sql/language-manual/sql-ref-functions-builtin.html#window-functions)

---

**[← Anterior: Joins e Agregações](03-joins-aggregations.md) | [↑ Voltar para Data Transformation and Modeling](README.md) | [Próximo: Limpeza e Qualidade de Dados →](05-data-cleaning-and-quality.md)**
