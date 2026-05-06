# Contributing

Valeu por querer contribuir com o `gitlab-flow-cli`.

Este projeto foi pensado para times pequenos, entao a ideia aqui e manter o fluxo simples, direto e previsivel.

## Setup local

```bash
npm install
npm run build
npm link
```

Se quiser rodar sem `npm link`:

```bash
npm run dev -- start
```

## Fluxo recomendado

1. Crie uma branch descritiva.
2. Faça a mudança de forma pequena e objetiva.
3. Rode a validação local.
4. Atualize documentação se o comportamento mudou.
5. Abra a MR com contexto claro.

## Nomes de branch

Prefira nomes nesse estilo:

```text
feat/readme-hero
fix/mr-assignee
docs/setup-instructions
```

## Checklist antes da MR

```bash
npm run check
```

Confirme tambem:

- a CLI continua compilando
- o README ainda bate com o comportamento real
- nenhuma credencial foi adicionada ao repositorio

## Padroes do projeto

- TypeScript com foco em clareza
- sem dependencias desnecessarias
- prompts simples e objetivos
- mensagens de terminal em portugues

## Seguranca

Nunca suba:

- `.env`
- tokens do GitLab
- arquivos locais de configuracao pessoal

Use sempre o arquivo [`.env.example`](./.env.example) como referencia.

## Dicas

- se o comando global nao atualizar, rode `npm run build && npm link`
- se quiser resetar a configuracao local, remova `~/.gl-work`

## Dúvidas

Se uma mudança tiver impacto no fluxo do time, prefira explicar bem o contexto no PR antes de expandir o escopo.
