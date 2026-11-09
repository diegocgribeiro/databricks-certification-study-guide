# Site de estudos — Certificações Databricks (PT-BR)

Site estático (HTML + CSS + JavaScript puro) para estudar e praticar **todas as 6 certificações** deste repositório.

**Acesse:** <https://diegocgribeiro.github.io/databricks-certification-study-guide/>

| Certificação | Questões | Conteúdo |
| :--- | :---: | :--- |
| Data Engineer Associate | 235 | 🇧🇷 PT-BR ([`data-engineer-associate-ptbr/`](../data-engineer-associate-ptbr/README.md)) |
| Generative AI Engineer Associate | 185 | 🇧🇷 PT-BR ([`genai-engineer-associate-ptbr/`](../genai-engineer-associate-ptbr/pt-br/README.md)) |
| Data Engineer Professional | 278 | Inglês |
| Data Analyst Associate | 249 | Inglês |
| Machine Learning Associate | 203 | Inglês |
| Machine Learning Professional | 187 | Inglês |

As questões ficam em inglês (como na prova). O conteúdo usa a tradução PT-BR quando existe; senão, o original em inglês.

## O que o site faz

- **Painel** por certificação: estimativa de acerto, desempenho e cobertura por domínio, próximo passo recomendado
- **Estudar**: aulas renderizadas com índice, diagramas e marcação de "lida"
- **Praticar** com correção imediata, explicação, botão de tradução e **alternativas embaralhadas** a cada vez
- **Confiança** (certeza × chute) e **revisão espaçada** (1, 3, 7, 16, 35 dias)
- **Caderno de erros**, **pontos fracos** e as **aulas para reestudar** (cada questão é ligada automaticamente à aula mais parecida)
- **Simulados** cronometrados (fixos e aleatório ponderado) com nota por domínio e plano de estudo
- Anotações, ⭐ marcações, estatísticas, backup/importação do progresso, tema claro/escuro

## Resiliência

- Cada certificação é carregada **sob demanda** (`data/<cert>.js`); se a rede falhar, aparece "Tentar de novo" sem perder nada
- Progresso **separado por certificação** no `localStorage`; JSON corrompido é **guardado em backup**, nunca apagado em silêncio
- Questões malformadas são descartadas no build e no navegador, sem quebrar a página
- Cada tela roda num *error boundary*: um erro mostra aviso e o resto do site continua funcionando
- **Service worker** guarda os arquivos para abrir **offline** depois da primeira visita
- Sem dependências (só o Mermaid, opcional, para diagramas); funciona até abrindo `index.html` direto do disco
- Importa automaticamente o progresso do site antigo do DE Associate (mesmo domínio `github.io`)

## Como atualizar os dados

Os dados são gerados a partir do que já existe no repositório (`practice/data/*.json` e os `.md` das certificações):

```bash
python study-site/build.py
```

Para adicionar a tradução PT-BR de outra certificação, crie `<cert>-ptbr/pt-br/certifications/<cert>/` com a mesma estrutura de `certifications/<cert>/` e rode o build — o site passa a usar o conteúdo em português automaticamente.

## Publicação

O GitHub Pages serve a branch `gh-pages`, que contém apenas a pasta `study-site/` já gerada. Para republicar depois de mudanças:

```bash
python study-site/build.py
git subtree split --prefix study-site -b gh-pages-tmp
git push -f origin gh-pages-tmp:gh-pages
git branch -D gh-pages-tmp
```

## Créditos

- Conteúdo original e questões: [kengio/databricks-certification-study-guide](https://github.com/kengio/databricks-certification-study-guide) (MIT)
- Tradução PT-BR do GenAI Engineer Associate: [Davi Emmerick](https://github.com/DaviEmmerick/databricks-certification-study-guide)
- Tradução PT-BR do Data Engineer Associate e este site: [Diego Ribeiro](https://github.com/diegocgribeiro)
- Material independente, não oficial da Databricks
