# Ponto+ Web

SPA do Ponto+ para registrar e acompanhar a jornada pessoal. A interface usa somente HTML, CSS e JavaScript, abre diretamente pelo `index.html` e preserva o visual aprovado no protótipo navegável.

## Estado atual

A base visual foi promovida para o projeto definitivo e o cliente HTTP de todas as rotas da API está centralizado em `js/api.js`. Cadastro, login, validação da sessão, perfil, batidas, desfazer e histórico já usam a API real. A recuperação de senha continua apenas demonstrativa porque não faz parte das rotas exigidas para este MVP.

## Funcionalidades da interface

- login e cadastro;
- dashboard com relógio, estado e sequência de batidas;
- desfazer a última batida durante cinco segundos;
- calendário e histórico por período;
- total trabalhado, meta diária e hora extra;
- perfil editável;
- temas claro e escuro;
- layout adaptado a desktop, tablet e celular.

## Tecnologias

- HTML semântico;
- CSS próprio com tokens de tema e media queries;
- JavaScript puro com navegação por hash;
- fontes e imagens locais, sem CDN ou etapa de build.

## Estrutura

```text
assets/       # Marca e fontes locais
css/          # Estilos e responsividade
js/api.js     # Comunicação com todas as rotas da API
js/app.js     # Navegação, telas e interações
index.html    # Entrada única da SPA
```

## Como abrir

1. Inicie a API em `http://127.0.0.1:5000`.
2. Abra `index.html` diretamente no Chrome ou Firefox.

O front-end não precisa de servidor local, instalação de pacotes, extensão ou configuração adicional do navegador.

## Testes

Os testes do front-end usam apenas o executor nativo do Node.js, sem instalar pacotes:

```bash
node --test tests/*.test.mjs
```

Eles validam sintaxe, arquivos locais, uso de todas as rotas, persistência do token, erros de conexão, expiração da sessão, agrupamento das batidas e cálculo diário.

## Contrato com a API

O cliente em `js/api.js` oferece operações para:

- cadastrar e autenticar;
- consultar e atualizar o perfil;
- obter o histórico mensal;
- registrar a próxima batida;
- desfazer a última batida.

O token JWT é enviado no cabeçalho `Authorization`. A opção “Lembrar de mim” define se ele ficará no armazenamento local ou apenas na sessão do navegador.

## Próxima etapa

Executar o QA integrado em Chrome e Firefox com a API ativa, cobrindo responsividade, navegação por teclado, expiração de sessão e todos os estados da jornada.
