# Ponto+ Web

SPA para registrar e acompanhar a jornada pessoal. Usa somente HTML, CSS e JavaScript e abre diretamente pelo `index.html`, mantendo a identidade visual do navegável.

## Estado e escopo

Cadastro, login, perfil, meta diária, batidas, desfazer e histórico usam a API real. A rota de disponibilidade é consultada na abertura. **Notificações e recuperação de senha são demonstrativas**, por decisão do usuário: não há envio real de alertas/e-mails nem redefinição de senha.

Vídeo e publicação dos dois repositórios no GitHub ficam para depois. O aplicativo é um MVP acadêmico de acompanhamento pessoal, não um sistema empresarial certificado.

## Funcionalidades

- Login/cadastro e proteção das telas autenticadas.
- Dashboard com relógio de São Paulo, estado e sequência das batidas.
- Desfazer no próprio botão por até cinco segundos.
- Calendário mensal, detalhes do dia e histórico por período.
- Cronômetro, total dos últimos sete dias, meta e horas extras.
- Nome e meta diária editáveis, persistidos na API por usuário.
- Temas claro/escuro, estilos responsivos e navegação por teclado.
- Notificações demonstrativas com estado vazio e indicador de itens não lidos.

## Tecnologias e organização

HTML semântico e CSS próprio mantêm a interface acessível e independente de frameworks. A SPA navega por hash, sem recarregar o documento. Fontes/imagens são locais, sem CDN, build ou instalação para abrir a interface.

```text
assets/                # Marca, imagens e fontes locais
css/styles.css         # Tokens de tema, componentes e media queries
js/api.js              # Cliente HTTP das oito operações da API
js/app.js              # Rotas, telas, estado, cálculos e interações
tests/frontend.test.mjs # Verificações de arquivos e contrato básico
tests/regressions.test.mjs # Sessão, concorrência, datas, totais e formulários
tests/helpers.mjs      # Relógio, DOM e API simulados para testes isolados
index.html             # Entrada única da SPA e atalho de acessibilidade
```

Código/identificadores estão em inglês; interface, comentários e documentação, em português.

## Como abrir

1. Instale as dependências e inicie `ponto-api` seguindo o README daquele repositório.
2. Confirme `http://127.0.0.1:5000/api/health`.
3. Abra o `index.html` desta pasta diretamente no Chrome ou Firefox.
4. Cadastre uma conta ou entre com uma conta existente.

A interface não precisa de servidor local, pacotes, extensão ou configuração extra de segurança no navegador. A API aceita a origem `null` usada pelo arquivo local.

Depois de atualizar os arquivos, recarregue a página. Caso a atualização tenha trocado a antiga chave JWT insegura, será necessário entrar novamente. As contas e batidas ficam no banco da API.

## Navegação

| Rota | Tela |
|---|---|
| `#/login` | Entrar |
| `#/cadastro` | Criar conta |
| `#/dashboard` | Minha jornada |
| `#/calendario` | Calendário e detalhes do dia |
| `#/historico` | Histórico por período |
| `#/perfil` | Configurações da conta |

Calendário e histórico são seções do painel com navegação própria. Selecionar uma data altera os detalhes do dia, sem alterar o filtro independente do histórico. O histórico inicia nos últimos sete dias e aceita um intervalo de 1 a 31 dias, inclusive atravessando meses. O seletor não oferece datas futuras.

## Comunicação com o back-end

| Operação | Onde é usada |
|---|---|
| `GET /api/health` | Verificação na abertura da SPA |
| `POST /api/auth/register` | Formulário de cadastro |
| `POST /api/auth/login` | Formulário de login |
| `GET /api/profile` | Validação da sessão e sincronização |
| `PATCH /api/profile` | Salvar nome e meta diária |
| `GET /api/punches?month=YYYY-MM` | Painel, calendário e histórico |
| `POST /api/punches` | Registrar a próxima batida |
| `DELETE /api/punches/{id}` | Desfazer a última batida |

`js/api.js` centraliza URL, métodos, JSON, cabeçalho `Authorization: Bearer <token>` e limite de resposta de dez segundos, incluindo leitura do corpo.

A API persiste `User` (nome, e-mail, hash, meta, revisão e cadastro) e `Punch` (usuário, tipo e instante UTC). O navegador mantém apenas o estado necessário à tela; não é a fonte oficial das batidas ou da meta.

### Sessão e sincronização

- “Lembrar de mim” salva o token em `localStorage`; sem a opção, ele fica em `sessionStorage`.
- Logout/expiração/troca de conta apagam o estado privado da interface. Respostas pendentes da sessão anterior são descartadas, inclusive um `401` que chegue depois do login em outra conta.
- A aplicação verifica a expiração enquanto estiver aberta; a API também verifica o JWT em cada chamada protegida.
- Sincronização ao voltar à aba/janela, ao receber sinal de outra aba e a cada 15 segundos.
- A meta vem do perfil da API, não de uma preferência global do navegador. Contas anteriores à migração começam com 8h e podem ajustar a meta em Configurações.
- POST envia `expected_revision` e `expected_date`; DELETE envia a revisão. Em conflito `409`, a interface busca o estado atual e exige um novo clique, sem tentar registrar automaticamente outra batida.
- A resposta completa da API substitui o estado local. Uma revisão antiga não pode sobrescrever uma nova.
- Botão de ponto fica bloqueado durante a carga inicial e a gravação; não há acúmulo de cliques enquanto a requisição estiver pendente.

O JWT é sem estado no servidor: sair do navegador não revoga uma cópia externa já emitida, que permanece válida até a expiração de 24h. Revogação remota não faz parte deste MVP.

## Jornada, horas e meta

A sequência é Entrada → Início do intervalo → Retorno → Saída. O servidor determina o tipo e o horário; a interface não envia horários inventados.

Depois de cada batida, o mesmo botão mostra “Desfazer” pelo tempo restante de cinco segundos. Após a quarta, mostra “Desfazer saída”; encerrado o prazo, fica desativado como “Jornada encerrada”. A exclusão é validada pela API.

O cronômetro soma apenas entrada → intervalo e retorno → saída, avançando a cada segundo durante o trabalho e parando no intervalo/saída. A meta pessoal é de 00:01 a 23:59, padrão 08:00, usada também nas comparações do histórico. Não há histórico de versões da meta.

O gráfico mostra o tempo até a meta em azul e o excedente em vermelho. Sua escala se adapta ao total e mantém um marcador da meta. O resumo dos últimos sete dias acompanha os minutos trabalhados; a meta semanal exibida é cinco vezes a meta diária.

Datas aparecem como **“Terça-feira, 15 de setembro”**. Instantes são exibidos em São Paulo; datas selecionadas no calendário mantêm o mesmo dia mesmo em um computador configurado para outro fuso.

### Dia anterior incompleto

O MVP assume início e fim da jornada no mesmo dia de São Paulo. Se um dia passado tem apenas 1–3 batidas:

- Mostrar **Jornada incompleta**, sem classificar a falta de registro como saída antecipada.
- Somar somente períodos com início e fim registrados.
- Mostrar **Total parcial confirmado** nos detalhes, **parcial** na tabela e saldo final **—**.
- Não inventar saída, não apagar batidas e não prolongar um trecho aberto até o dia seguinte.
- Permitir que o dia atual comece normalmente.

Exemplo: entrada às 08:00, intervalo às 12:00 e retorno às 13:00, sem saída. O total parcial confirmado é 4h; o tempo após as 13:00 é desconhecido e não pode ser calculado com segurança. Com apenas uma entrada, o parcial confirmado é zero, sem afirmar que a pessoa não trabalhou.

A virada do dia/mês é detectada automaticamente: o botão aguarda a consulta da nova jornada antes de liberar “Registrar entrada”.

## Notificações e recuperação demonstrativas

O sino abre um menu azul de vidro fosco, sem bordas/divisória, com sombra e animação. No desktop ele vai do sino ao fim da pílula do usuário; em telas menores usa margens laterais. A bolinha azul só aparece com itens não lidos. A coleção inicia vazia, com “Sem novas notificações”.

A recuperação de senha apenas demonstra o formulário/retorno visual; não envia e-mail nem altera a senha. Essas limitações são intencionais e não devem ser apresentadas como integrações reais no vídeo.

## Testes

É necessário Node.js 22 ou superior apenas para executar os testes; a interface não depende dele. Na pasta deste repositório:

```bash
node --test tests/*.test.mjs
```

Os **37 testes** passaram nesta rodada. Verificam arquivos/sintaxe, todas as operações, erros/timeout, sessão e respostas atrasadas, perfil/meta, revisão desatualizada, meia-noite/mudança de mês, calendário em quatro fusos, período de 31 dias, jornadas incompletas, tempo semanal, gauge, posicionamento calculado das notificações, contraste AA e a integridade de IDs/referências ARIA em todas as rotas.

Os testes usam DOM, relógio e API simulados, sem navegador e sem modificar dados reais. **Não atestam renderização visual, compatibilidade real entre navegadores, blur, animação ou responsividade.** O QA visual integrado continua pendente: a automação do arquivo local foi bloqueada pela ferramenta na revisão. Não usar servidor de front-end ou extensões para contornar o bloqueio.

## Problemas comuns

- **Falha de conexão/timeout:** confirme que a API está ativa na porta 5000. O cliente limita a espera a dez segundos.
- **Sessão expirada:** faça login novamente; histórico e meta estão no banco.
- **Jornada atualizada em outra aba:** confira os registros recarregados e só então clique na ação desejada.
- **Jornada incompleta:** falta uma ou mais batidas em um dia anterior. O parcial não é o total definitivo; não existe edição retroativa neste escopo.
- **Dados sem registro:** “Sem registros” não significa ausência/falta; não são criadas penalidades a partir de dias vazios.
- **Menu ou layout diferente:** recarregue os arquivos atualizados e registre a divergência para o QA visual.

## Vídeo e publicação, em etapa posterior

O vídeo deve durar até quatro minutos: apresentar o propósito; demonstrar no Swagger ao menos quatro rotas, incluindo POST; mostrar a interface usando as rotas. Incluir a verificação de disponibilidade, cadastro/login, perfil/meta, histórico, registro e desfazer. Não apresentar os fluxos demonstrativos como serviços reais.

Manter este repositório separado de `ponto-api` e publicar ambos como públicos quando o usuário autorizar essa etapa.
