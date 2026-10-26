# A Hero's Destiny — servidor online

Este é o servidor do modo online: chat global, alianças, boosts globais, saves na nuvem e o mundo compartilhado (todo mundo no mesmo mapa vê os mesmos monstros e luta junto). Ele também serve o próprio jogo: quem abre o link do servidor já joga conectado.

Não precisa instalar nada: o servidor usa só o Node.js (sem pacotes extras).

## O que tem nesta pasta

| Arquivo | Para quê |
|---|---|
| `server.js` | O servidor (contas, saves, chat, alianças, salas dos mapas) |
| `ws.js` | O WebSocket (a conexão em tempo real com o jogo) |
| `public/index.html` | O jogo (é o mesmo `AHD.html`) |
| `render.yaml` | O "script" do Render: cria o servidor sozinho |
| `package.json` | Diz ao Render como iniciar |

## Colocar no ar no Render (grátis)

1. Crie uma conta no [GitHub](https://github.com) e um repositório novo (pode ser privado).
2. Envie **todos os arquivos desta pasta** para o repositório (em "Add file → Upload files" dá para arrastar tudo, inclusive a pasta `public`). O `render.yaml` precisa ficar na raiz do repositório, fora de qualquer pasta.
3. Crie uma conta no [Render](https://render.com) e conecte o GitHub.
4. No Render, clique em **New → Blueprint**, escolha o repositório e confirme (**Apply**). O Render lê o `render.yaml` e cria o serviço `ahd-servidor`.
5. Espere o primeiro deploy terminar (1 a 3 minutos). O Render mostra um link parecido com `https://ahd-servidor.onrender.com`.
6. Abra esse link: é o jogo, já conectado. Mande o mesmo link para o outro jogador.

Sem Blueprint também dá: **New → Web Service**, escolha o repositório, *Runtime* Node, *Build Command* `npm install`, *Start Command* `node server.js`, plano **Free**.

## Jogando online

- Entre ou crie a conta normalmente. Se você já tinha uma conta neste navegador, ela sobe para o servidor sozinha na primeira vez (com o mesmo nome e senha).
- O botão **🌐** no canto mostra quem está online, troca entre **modo online** (mundo compartilhado) e **modo offline** (mundo só seu) e cuida da aliança.
- O botão **💬** (ou a tecla **/**) abre o chat global. O chat funciona nos dois modos e mostra o título e o nível de cada jogador.
- Abrindo o `AHD.html` direto do computador: na tela de login, clique em **servidor** e cole o link do Render.

### Regras do modo online

- Quem estiver no mesmo mapa vê os outros jogadores, os mesmos monstros, os ataques e as habilidades de todo mundo.
- **Aliança**: quando um aliado vence uma missão, você ganha **45%** dos ganhos dela (atributos, XP, Yen, pontos de herói e maestria). Quem venceu ganha 100%.
- **Chefes**: todos que bateram no chefe ganham **100%** quando ele cai (vale também para Raid, Torre, inimigos da história e chefes do ADM).
- **Boosts** (Global 2x, Yen 2x...) usados no modo online valem para **todos** os jogadores online. O mesmo boost não soma duas vezes.
- Morte, Determinação e as classes do **Dark Spin** são de cada um.
- Raid e Torre são compartilhadas (o chefe ganha mais vida com mais jogadores). Os Desafios são individuais.
- Com menu ou conversa aberta, o mundo continua (os outros jogadores não param) — o seu herói só fica parado.

## Os saves

- Cada jogador tem o seu save, guardado separado. O servidor só entrega o save para o dono da conta e nunca carrega dois saves juntos.
- O jogo guarda o save **no navegador e no servidor** (a cada ~25 segundos). Ao entrar, ele usa o mais jogado dos dois.
- **Plano grátis do Render:** o servidor dorme depois de 15 minutos sem ninguém e demora uns 30 a 60 segundos para acordar. Quando ele reinicia, os arquivos do servidor somem — mas o jogo manda o save do navegador de volta sozinho quando o jogador entra. Só se perde o save se você trocar de aparelho **e** o servidor tiver reiniciado antes.
- Para os saves ficarem para sempre no servidor: no Render, use um plano pago (Starter) com um disco e defina `DATA_DIR=/var/data` (o `render.yaml` já tem as linhas prontas, é só tirar o `#`).

## Atualizar o jogo

Troque `public/index.html` pelo `AHD.html` novo e envie para o GitHub. O Render faz o deploy sozinho. O jogo e o servidor precisam estar na mesma versão; se não estiverem, o jogo avisa e continua offline.

## Testar no computador

Com o Node.js 18 ou mais novo:

```
node server.js
```

e abra `http://localhost:3000`. Os dados ficam na pasta `data/`.

Endereços úteis: `/health` (o Render usa para saber se está vivo) e `/status` (quantos jogadores e salas).
