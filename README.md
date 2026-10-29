# A Hero's Destiny — servidor online

Este é o servidor do modo online: chat global, alianças, boosts globais, saves na nuvem e o mundo compartilhado (todo mundo no mesmo mapa vê os mesmos monstros e luta junto). Ele também serve o próprio jogo: quem abre o link do servidor já joga conectado.

Não precisa instalar nada: o servidor usa só o Node.js (sem pacotes extras).

## Os arquivos

| Arquivo | Para quê |
|---|---|
| `server.js` | O servidor (contas, saves, chat, alianças, salas dos mapas) |
| `ws.js` | O WebSocket (a conexão em tempo real com o jogo) |
| `AHD.html` | O jogo |
| `render.yaml` | O "script" do Render: cria o servidor sozinho |
| `package.json` | Diz ao Render como iniciar |

Todos ficam soltos na raiz do repositório, sem pastas.

## Colocar no ar no Render (grátis)

1. Crie uma conta no [GitHub](https://github.com) e um repositório novo (pode ser privado).
2. Envie os arquivos: na página do repositório, toque em **uploading an existing file** (repositório vazio) ou **Add file → Upload files**, escolha os cinco arquivos de uma vez e confirme em **Commit changes**.
3. Crie uma conta no [Render](https://render.com) entrando com o GitHub.
4. No Render: **New → Blueprint**, toque em **Connect** no repositório, dê um nome qualquer e confirme em **Deploy Blueprint**. O Render lê o `render.yaml` e cria o serviço `ahd-servidor`.
5. Espere o primeiro deploy terminar (1 a 3 minutos). O Render mostra um link parecido com `https://ahd-servidor.onrender.com`.
6. Abra esse link: é o jogo, já conectado. Mande o mesmo link para o outro jogador.

Sem Blueprint também dá: **New → Web Service**, escolha o repositório, *Runtime* Node, *Build Command* `npm install`, *Start Command* `node server.js`, plano **Free**.

### Pelo celular

- Use o site do GitHub no navegador (Chrome ou Safari). Se algum botão não aparecer, ative **Site para computador** no menu do navegador.
- `server.js`, `ws.js`, `package.json` e `render.yaml` precisam ficar com esses nomes exatos. O jogo pode ter outro nome (por exemplo `AHD (1).html`): o servidor acha o `.html` sozinho.

## Jogando online

- Entre ou crie a conta normalmente. Se você já tinha uma conta neste navegador, ela sobe para o servidor sozinha na primeira vez (com o mesmo nome e senha).
- O botão **🌐** no canto mostra quem está online, troca entre **modo online** (mundo compartilhado) e **modo offline** (mundo só seu) e cuida da aliança.
- O botão **💬** (ou a tecla **/**) abre o chat global. O chat funciona nos dois modos e mostra o título e o nível de cada jogador.
- Abrindo o `AHD.html` direto do aparelho: na tela de login, toque em **servidor** e cole o link do Render.

### Regras do modo online

- Quem estiver no mesmo mapa vê os outros jogadores, os mesmos monstros, os ataques e as habilidades de todo mundo.
- **Aliança**: quando um aliado vence uma missão, você ganha **45%** dos ganhos dela (atributos, XP, Yen, pontos de herói e maestria). Quem venceu ganha 100%.
- **Chefes**: todos que bateram no chefe ganham **100%** quando ele cai (vale também para Raid, Torre, inimigos da história e chefes do ADM).
- **Boosts** (Global 2x, Yen 2x...) usados no modo online valem para **todos** os jogadores online. O mesmo boost não soma duas vezes.
- Morte, Determinação e as classes do **Dark Spin** são de cada um.
- Raid e Torre são compartilhadas (o chefe ganha mais vida com mais jogadores). Os Desafios são individuais.
- Com menu ou conversa aberta, o mundo continua (os outros jogadores não param) — o seu herói só fica parado.

## Novidades da versão 6

- **Arena PVP**: no lobby, o redemoinho vermelho ao lado da arena dos desafios leva à Arena PVP. Só vale no modo online. O dano é equilibrado pela força de cada um (ninguém derruba o outro com um golpe), e cair na arena não tem castigo — nem no Hardcore.
- **Painel do Dev** (antigo painel ADM): na tela de entrada ou em Configurações → **🛠️ Painel do Dev**, senha **996908**. Conectado ao servidor, mostra todos os jogadores online (de todos os servidores) com vida, classe, zona, Yen e força, e deixa dar e tirar recursos, curar, matar, teleportar, trolar, mandar mensagem, controlar o herói, silenciar, expulsar e banir. O servidor confere a senha do lado dele.
- **Dificuldades**: cada mundo (Fácil, Médio, Difícil, Hardcore) tem as suas salas de mapa; o chat é o mesmo para todos. No Hardcore, quando o herói morre, a conta e o save somem também do servidor.
- **Salas SandBox**: veja a seção abaixo.

## Modo SandBox (servidor personalizado)

Cada servidor do Render pode ter várias **salas SandBox**. Uma sala é um mundo só dela: contas, saves, chat, alianças e regras próprias. Só entra quem souber o **nome** e a **senha** da sala.

**Criar uma sala**

1. Na tela de entrada do jogo, toque em **🧪 Criar servidor personalizado**.
2. Cole o link do seu servidor do Render (se você abriu o jogo pelo link do servidor, ele já vem preenchido).
3. Escolha **Criar sala**, dê um nome e uma senha e toque em **🧪 SandBox**. Se o servidor estiver dormindo, o jogo espera ele acordar (até 1 minuto).
4. Crie a sua conta dentro da sala: **a primeira conta criada por quem criou a sala vira o ADM da sala**.
5. Para os amigos: mesmo link, **Entrar numa sala**, o mesmo nome e a mesma senha.

**O painel do ADM da sala** (botão **🛠️ ADM** ao lado do nome da sala, no canto do jogo) — só o dono da sala abre:

| Aba | O que dá para fazer |
|---|---|
| 🌍 Mundo | Dificuldade da sala (ou cada um escolhe), todos os números da dificuldade (vida e ataque dos inimigos, recompensas, XP, maestria, preços, recargas...), morte permanente, Forja, Saitama, Dark Spin, história original, PVP, Raid e Torre |
| 👹 Zonas | Por zona (ou todas): vida, ataque, quantidade e nome dos monstros, corpo e cor; chefe normal, **sem chefe** ou **montado no Criador de Chefes** (nome, aparência, barras, atributos, habilidades, golpe supremo) e o prêmio extra dele |
| ⭐ Classes | Classes novas (raridade, jeito de lutar, elemento, passiva, 4 habilidades, despertar, Spin ou **Forja** com receita), raridade das classes do jogo e classes fora do Spin |
| 🎒 Itens | Materiais, artefatos e boosts novos (um boost pode valer para vários tipos ao mesmo tempo) |
| 🛒 Loja | Melhorias da loja da sala (efeito, preço, moeda, nível máximo) e bônus para todos na sala |
| 📜 Missões | Pessoas (aparência, falas, lugar, loja) e missões com passos (falar, derrotar, chefe da zona, chegar, achar itens, lutar com um chefe montado, treinar) e recompensas |
| 🧱 Terreno | Desenhe no mapa: chão, caminho, água, abismo, paredes, objetos (até passagens secretas), baús (com prêmio, até escondidos), placas, portais (secretos também), ninhos de chefe e de monstros, fontes de cura, balcões da loja e a entrada do mapa |
| 👥 Jogadores | Os jogadores da sala com vida e status: dar, tirar, curar, matar, teleportar, trolar, controlar, silenciar, expulsar e banir |
| ⚙️ Sala | Nome, boas-vindas, presente para quem entra, senha da sala, modelos prontos e copiar/colar o código da sala |

**💾 Salvar para todos** manda o mundo para todo mundo da sala na hora. O terreno salva sozinho enquanto você desenha.

**No Render grátis:** quando o servidor reinicia, as salas somem. O jogo ajuda: em **↩️ Voltar para a sala** ele oferece criar a sala de novo com o mesmo nome e senha, o seu save volta do navegador e, ao entrar como ADM, ele oferece **restaurar** o mundo que você montou (o navegador guarda uma cópia). Para garantir, use **⚙️ Sala → Copiar código da sala** de vez em quando.

## Os saves

- Cada jogador tem o seu save, guardado separado. O servidor só entrega o save para o dono da conta e nunca carrega dois saves juntos.
- O jogo guarda o save **no navegador e no servidor** (a cada ~25 segundos). Ao entrar, ele usa o mais jogado dos dois.
- **Plano grátis do Render:** o servidor dorme depois de 15 minutos sem ninguém e demora uns 30 a 60 segundos para acordar. Quando ele reinicia, os arquivos do servidor somem — mas o jogo manda o save do navegador de volta sozinho quando o jogador entra. Só se perde o save se você trocar de aparelho **e** o servidor tiver reiniciado antes.
- Para os saves ficarem para sempre no servidor: no Render, use um plano pago (Starter) com um disco e defina `DATA_DIR=/var/data` (o `render.yaml` já tem as linhas prontas, é só tirar o `#`).

## Atualizar o jogo

Envie o `AHD.html` novo para o repositório do mesmo jeito (**Add file → Upload files**). O Render faz o deploy sozinho, e o servidor sempre usa o jogo mais novo, mesmo que o nome do arquivo tenha mudado. O jogo e o servidor precisam estar na mesma versão; se não estiverem, o jogo avisa e continua offline.

## Testar no computador

Com o Node.js 18 ou mais novo:

```
node server.js
```

e abra `http://localhost:3000`. Os dados ficam na pasta `data/`.

Endereços úteis: `/health` (o Render usa para saber se está vivo) e `/status` (quantos jogadores e salas, e a versão do jogo carregada).
