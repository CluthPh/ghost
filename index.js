import "dotenv/config";
import Database from "better-sqlite3";
import express from "express";
import cron from "node-cron";
import {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
  PermissionsBitField,
  Collection,
} from "discord.js";

/**
 * =========================
 * Helpers
 * =========================
 */
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Faltou env: ${name}`);
  return v;
}

const TOKEN = mustEnv("TOKEN");
const CLIENT_ID = mustEnv("CLIENT_ID");

const GUILD_ID = mustEnv("GUILD_ID");
const VERIFY_CHANNEL_ID = mustEnv("VERIFY_CHANNEL_ID");
const INVITE_CHANNEL_ID = mustEnv("INVITE_CHANNEL_ID");

const VERIFIED_ROLE_ID = mustEnv("VERIFIED_ROLE_ID");

const ROLE_BRONZE_ID = mustEnv("ROLE_BRONZE_ID");
const ROLE_PRATA_ID = mustEnv("ROLE_PRATA_ID");
const ROLE_OURO_ID = mustEnv("ROLE_OURO_ID");
const ROLE_PLATINA_ID = mustEnv("ROLE_PLATINA_ID");
const ROLE_DIAMANTE_ID = mustEnv("ROLE_DIAMANTE_ID");

const MIN_ACCOUNT_AGE_DAYS = Number(process.env.MIN_ACCOUNT_AGE_DAYS || 0);
const MIN_STAY_HOURS = Number(process.env.MIN_STAY_HOURS || 0);

// Dashboard
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 3000);
const DASHBOARD_ENABLED = (process.env.DASHBOARD_ENABLED ?? "1") !== "0";

// Cron (segunda-feira 10:00, horário do servidor)
const WEEKLY_REPORT_CRON = process.env.WEEKLY_REPORT_CRON || "0 10 * * 1";
const WEEKLY_REPORT_ENABLED = (process.env.WEEKLY_REPORT_ENABLED ?? "1") !== "0";

const ALL_RANK_ROLE_IDS = [
  ROLE_BRONZE_ID,
  ROLE_PRATA_ID,
  ROLE_OURO_ID,
  ROLE_PLATINA_ID,
  ROLE_DIAMANTE_ID,
];

/**
 * =========================
 * DB (SQLite)
 * =========================
 */
const db = new Database("ghost.db");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_invites (
  user_id TEXT PRIMARY KEY,
  invite_code TEXT NOT NULL,
  invite_url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS joins (
  member_id TEXT PRIMARY KEY,
  inviter_id TEXT,
  invite_code TEXT,
  joined_at INTEGER NOT NULL,
  counted_real INTEGER NOT NULL DEFAULT 0,
  reversed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inviter_stats (
  user_id TEXT PRIMARY KEY,
  real_joins INTEGER NOT NULL DEFAULT 0
);
`);

const getSetting = db.prepare("SELECT value FROM settings WHERE key=?");
const setSetting = db.prepare(`
  INSERT INTO settings(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`);

const getPersonalInviteByUser = db.prepare(
  "SELECT invite_code, invite_url FROM personal_invites WHERE user_id=?"
);
const getPersonalInviteOwnerByCode = db.prepare(
  "SELECT user_id FROM personal_invites WHERE invite_code=?"
);
const upsertPersonalInvite = db.prepare(`
  INSERT INTO personal_invites(user_id, invite_code, invite_url, created_at)
  VALUES(?,?,?,?)
  ON CONFLICT(user_id) DO UPDATE SET
    invite_code=excluded.invite_code,
    invite_url=excluded.invite_url,
    created_at=excluded.created_at
`);

const getJoinRow = db.prepare(
  "SELECT member_id, inviter_id, invite_code, joined_at, counted_real, reversed FROM joins WHERE member_id=?"
);
const hasJoin = db.prepare("SELECT 1 FROM joins WHERE member_id=?");
const insertJoin = db.prepare(`
  INSERT INTO joins(member_id, inviter_id, invite_code, joined_at, counted_real, reversed)
  VALUES(?,?,?,?,?,0)
`);

const markReversed = db.prepare(`
  UPDATE joins SET reversed=1 WHERE member_id=?
`);

const incInviter = db.prepare(`
  INSERT INTO inviter_stats(user_id, real_joins)
  VALUES(?,1)
  ON CONFLICT(user_id) DO UPDATE SET real_joins = real_joins + 1
`);

const decInviter = db.prepare(`
  UPDATE inviter_stats
  SET real_joins = CASE WHEN real_joins > 0 THEN real_joins - 1 ELSE 0 END
  WHERE user_id=?
`);

const getInviterCount = db.prepare(
  "SELECT real_joins FROM inviter_stats WHERE user_id=?"
);

const getTopRanking = db.prepare(`
  SELECT user_id, real_joins
  FROM inviter_stats
  ORDER BY real_joins DESC, user_id ASC
  LIMIT ?
`);

const getAllInviterStats = db.prepare(`
  SELECT user_id, real_joins
  FROM inviter_stats
  ORDER BY real_joins DESC, user_id ASC
`);

/**
 * =========================
 * Rank Logic
 * =========================
 * bronze 1-13
 * prata 14-29
 * ouro 30-59
 * platina 60-99
 * diamante 100+
 */
function rankRoleIdByInvites(count) {
  if (count >= 100) return ROLE_DIAMANTE_ID;
  if (count >= 60) return ROLE_PLATINA_ID;
  if (count >= 30) return ROLE_OURO_ID;
  if (count >= 14) return ROLE_PRATA_ID;
  if (count >= 1) return ROLE_BRONZE_ID;
  return null;
}

function rankNameByInvites(count) {
  if (count >= 100) return "DIAMANTE";
  if (count >= 60) return "PLATINA";
  if (count >= 30) return "OURO";
  if (count >= 14) return "PRATA";
  if (count >= 1) return "BRONZE";
  return "SEM RANK";
}

function nextRankInfo(count) {
  if (count >= 100) return { next: null, missing: 0 };

  const steps = [
    { name: "BRONZE", min: 1 },
    { name: "PRATA", min: 14 },
    { name: "OURO", min: 30 },
    { name: "PLATINA", min: 60 },
    { name: "DIAMANTE", min: 100 },
  ];

  for (const s of steps) {
    if (count < s.min) return { next: s.name, missing: s.min - count };
  }
  return { next: null, missing: 0 };
}

async function syncInviterRank(guild, inviterId, count) {
  const member = await guild.members.fetch(inviterId).catch(() => null);
  if (!member) return;

  const targetRoleId = rankRoleIdByInvites(count);
  if (!targetRoleId) return;

  // Remove ranks antigos
  const toRemove = ALL_RANK_ROLE_IDS.filter((rid) => member.roles.cache.has(rid));
  if (toRemove.length) await member.roles.remove(toRemove).catch(() => null);

  // Add rank correto
  if (!member.roles.cache.has(targetRoleId)) {
    await member.roles.add(targetRoleId).catch(() => null);
  }
}

/**
 * =========================
 * Invite / "Pessoa REAL" (antifraude heurístico)
 * =========================
 */
function isSuspiciousUsername(username) {
  const u = (username || "").toLowerCase();
  return (
    /^user\d{4,}$/.test(u) || // user12345
    /^discord\d{4,}$/.test(u) || // discord1234
    /^guest\d{3,}$/.test(u) || // guest123
    /^novo\d{3,}$/.test(u) // novo123
  );
}

function isRealEnough(member) {
  if (member.user.bot) return false;

  // idade mínima (se configurada)
  if (MIN_ACCOUNT_AGE_DAYS) {
    const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
    if (ageDays < MIN_ACCOUNT_AGE_DAYS) return false;
  }

  // heurísticas antifraude adicionais (não bloqueiam sempre, só ajudam)
  // Ajuste livre: aqui eu uso "regra dura" para reduzir fake.
  const suspiciousName = isSuspiciousUsername(member.user.username);
  const noAvatar = !member.user.avatar; // sem avatar custom (pode ser falso, mas é sinal)
  // se quiser ser menos agressivo, troque por "return true" quando suspeito.
  if (suspiciousName && noAvatar) return false;

  return true;
}

function leftTooFast(joinedAt) {
  if (!MIN_STAY_HOURS) return false;
  const hours = (Date.now() - joinedAt) / 3600000;
  return hours < MIN_STAY_HOURS;
}

/**
 * =========================
 * Discord Client
 * =========================
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // precisa ativar "Server Members Intent" no portal
    GatewayIntentBits.GuildInvites, // tracking de invites
  ],
});

const invitesCache = new Map(); // guildId -> Collection(invites)

/**
 * =========================
 * "Command Handler" (em 1 arquivo)
 * =========================
 */
const commands = new Collection();

// /rank
commands.set("rank", {
  name: "rank",
  description: "Mostra seu rank e quantos convites reais você tem.",
  async execute(interaction) {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "Servidor inválido.", ephemeral: true });

    const userId = interaction.user.id;
    const count = getInviterCount.get(userId)?.real_joins ?? 0;

    await syncInviterRank(guild, userId, count);

    const current = rankNameByInvites(count);
    const { next, missing } = nextRankInfo(count);

    const msg =
      `👻 **Seu Rank: ${current}**\n` +
      `📌 **Convites reais:** ${count}\n` +
      (next ? `🚀 **Próximo:** ${next} (faltam **${missing}**)` : `💎 **Topo:** DIAMANTE`);

    return interaction.reply({ content: msg, ephemeral: true });
  },
});

// /meulink
commands.set("meulink", {
  name: "meulink",
  description: "Mostra (ou cria) seu link pessoal de convite.",
  async execute(interaction) {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "Servidor inválido.", ephemeral: true });

    const url = await getOrCreatePersonalInvite(guild, interaction.user.id);
    return interaction.reply({
      content: `🔗 **Seu link pessoal:** ${url}\n📌 Use **/rank** pra ver sua progressão.`,
      ephemeral: true,
    });
  },
});

async function registerSlashCommands() {
  const body = [...commands.values()].map((c) => ({
    name: c.name,
    description: c.description,
  }));

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
}

/**
 * =========================
 * Verify Message (Button)
 * =========================
 */
async function ensureVerifyMessage(guild) {
  const verifyChannel = await guild.channels.fetch(VERIFY_CHANNEL_ID).catch(() => null);
  if (!verifyChannel || !verifyChannel.isTextBased()) return;

  const saved = getSetting.get("verify_message_id")?.value;
  if (saved) {
    const existing = await verifyChannel.messages.fetch(saved).catch(() => null);
    if (existing) return;
  }

  const embed = new EmbedBuilder()
    .setTitle("✅ Verificação obrigatória")
    .setDescription(
      [
        "Para liberar acesso ao conteúdo, convites e ranking, você precisa se verificar.",
        "",
        "**Sem verificação você fica sem:**",
        "• Acesso aos canais",
        "• Convites",
        "• Ranking / Progressão",
        "",
        "👇 Clique no botão abaixo para liberar sua entrada.",
      ].join("\n")
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ghost_verify")
      .setLabel("LIBERAR ACESSO")
      .setStyle(ButtonStyle.Success)
  );

  const msg = await verifyChannel.send({ embeds: [embed], components: [row] });
  setSetting.run("verify_message_id", msg.id);
}

/**
 * =========================
 * Invites (create/reuse per user)
 * =========================
 */
async function primeInviteCache(guild) {
  try {
    const invites = await guild.invites.fetch();
    invitesCache.set(guild.id, invites);
  } catch (e) {
    console.log("⚠️ Não consegui fetch de invites. Dê permissão MANAGE_GUILD ao bot.");
  }
}

async function getOrCreatePersonalInvite(guild, userId) {
  const existing = getPersonalInviteByUser.get(userId);
  if (existing?.invite_code) {
    const fetched = await guild.invites.fetch(existing.invite_code).catch(() => null);
    if (fetched?.url) return fetched.url;
  }

  const invite = await guild.invites.create(INVITE_CHANNEL_ID, {
    maxAge: 0, // nunca expira
    maxUses: 0, // ilimitado
    unique: true,
    reason: `Personal invite for user ${userId}`,
  });

  upsertPersonalInvite.run(userId, invite.code, invite.url, Date.now());
  return invite.url;
}

function progressText(inviteUrl) {
  return [
    "🚀 **Aqui nasce sua progressão.**",
    "",
    `🔗 **Seu link pessoal:** ${inviteUrl}`,
    "",
    "Cada pessoa **REAL** que entrar por ele:",
    "• Conta no ranking",
    "• Desbloqueia cargos",
    "• Abre novos canais",
    "",
    "⛔ Convites falsos são removidos automaticamente.",
    "",
    "📌 Use **/rank** pra ver seu progresso.",
  ].join("\n");
}

/**
 * =========================
 * Dashboard (Express)
 * =========================
 */
function startDashboard() {
  if (!DASHBOARD_ENABLED) return;

  const app = express();

  // health
  app.get("/", (_, res) => res.type("text").send("OK"));

  // top 10 default
  app.get("/ranking", (_, res) => {
    const top = getTopRanking.all(10);
    res.json({
      ok: true,
      limit: 10,
      data: top,
    });
  });

  // custom limit
  app.get("/ranking/:limit", (req, res) => {
    const n = Math.max(1, Math.min(100, Number(req.params.limit || 10)));
    const top = getTopRanking.all(n);
    res.json({
      ok: true,
      limit: n,
      data: top,
    });
  });

  app.listen(DASHBOARD_PORT, () => {
    console.log(`🌐 Dashboard API: http://localhost:${DASHBOARD_PORT}`);
    console.log(`   GET /ranking | GET /ranking/:limit`);
  });
}

/**
 * =========================
 * Weekly Report (Cron)
 * =========================
 */
function startWeeklyReportJob() {
  if (!WEEKLY_REPORT_ENABLED) return;

  cron.schedule(WEEKLY_REPORT_CRON, async () => {
    try {
      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (!guild) return;

      const rows = getAllInviterStats.all();

      // manda só pra quem tem pelo menos 1 (evita spam)
      const meaningful = rows.filter((r) => (r.real_joins ?? 0) > 0);
      if (!meaningful.length) return;

      // top 10 pro resumo
      const top10 = meaningful.slice(0, 10);
      const leaderboardText = top10
        .map((r, i) => `#${i + 1} <@${r.user_id}> — **${r.real_joins}**`)
        .join("\n");

      for (const r of meaningful) {
        const user = await client.users.fetch(r.user_id).catch(() => null);
        if (!user) continue;

        const count = r.real_joins ?? 0;
        const current = rankNameByInvites(count);
        const { next, missing } = nextRankInfo(count);

        const msg =
          `📊 **Relatório semanal**\n` +
          `✅ Seus convites reais: **${count}**\n` +
          `🏷️ Seu rank: **${current}**\n` +
          (next ? `🚀 Próximo: **${next}** (faltam **${missing}**)` : `💎 Você está no topo: **DIAMANTE**`) +
          `\n\n🏆 **Top 10 do servidor:**\n${leaderboardText}`;

        await user.send(msg).catch(() => null);
      }

      console.log(`📩 Relatório semanal enviado para ${meaningful.length} usuários.`);
    } catch (e) {
      console.log("⚠️ Erro no relatório semanal:", e?.message || e);
    }
  });

  console.log(`⏰ Weekly report cron ativo: "${WEEKLY_REPORT_CRON}"`);
}

/**
 * =========================
 * Ready
 * =========================
 */
client.once(Events.ClientReady, async () => {
  const guild = await client.guilds.fetch(GUILD_ID);

  // sanity: bot precisa permissões certas pra funcionar bem
  const me = await guild.members.fetch(client.user.id).catch(() => null);
  if (me) {
    const need = [
      PermissionsBitField.Flags.ManageGuild,
      PermissionsBitField.Flags.CreateInstantInvite,
      PermissionsBitField.Flags.ManageRoles,
    ];
    const ok = need.every((p) => me.permissions.has(p));
    if (!ok) console.log("⚠️ Dê ao bot: MANAGE_GUILD + CREATE_INSTANT_INVITE + MANAGE_ROLES.");
  }

  await primeInviteCache(guild);
  await ensureVerifyMessage(guild);
  await registerSlashCommands();

  startDashboard();
  startWeeklyReportJob();

  console.log(`✅ Bot online: ${client.user.tag}`);
});

/**
 * =========================
 * Interactions
 * =========================
 */
client.on(Events.InteractionCreate, async (interaction) => {
  // Slash commands via handler (em 1 arquivo)
  if (interaction.isChatInputCommand()) {
    const cmd = commands.get(interaction.commandName);
    if (!cmd) {
      return interaction.reply({ content: "Comando não encontrado.", ephemeral: true }).catch(() => null);
    }
    try {
      return await cmd.execute(interaction);
    } catch (e) {
      console.log("⚠️ Erro em comando:", interaction.commandName, e?.message || e);
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: "Erro ao executar o comando.", ephemeral: true }).catch(() => null);
      }
      return interaction.followUp({ content: "Erro ao executar o comando.", ephemeral: true }).catch(() => null);
    }
  }

  // Button Verify
  if (!interaction.isButton()) return;
  if (interaction.customId !== "ghost_verify") return;

  const guild = interaction.guild;
  if (!guild) return;

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return;

  // dá cargo verificado
  await member.roles.add(VERIFIED_ROLE_ID).catch(() => null);

  // gera/recupera link pessoal
  const url = await getOrCreatePersonalInvite(guild, member.id);

  // responde ephemeral
  await interaction.reply({ content: progressText(url), ephemeral: true }).catch(() => null);

  // tenta DM
  await interaction.user.send(progressText(url)).catch(() => null);

  // sincroniza rank (caso já tenha contagem antiga)
  const count = getInviterCount.get(member.id)?.real_joins ?? 0;
  await syncInviterRank(guild, member.id, count);
});

/**
 * =========================
 * Member Join -> Detect invite used
 * =========================
 */
client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== GUILD_ID) return;

  const guild = member.guild;
  const oldInvites = invitesCache.get(guild.id);

  let newInvites;
  try {
    newInvites = await guild.invites.fetch();
  } catch {
    return; // sem permissão MANAGE_GUILD, não dá pra trackear
  }
  invitesCache.set(guild.id, newInvites);

  if (!oldInvites) return;

  // acha invite que aumentou
  const used = newInvites.find((inv) => {
    const old = oldInvites.get(inv.code);
    const oldUses = old?.uses ?? 0;
    const newUses = inv.uses ?? 0;
    return newUses > oldUses;
  });

  if (!used) return;

  // só conta se for invite pessoal do nosso sistema
  const owner = getPersonalInviteOwnerByCode.get(used.code);
  if (!owner?.user_id) return;

  if (hasJoin.get(member.id)) return;

  const inviterId = owner.user_id;
  const counted = isRealEnough(member) ? 1 : 0;

  insertJoin.run(member.id, inviterId, used.code, Date.now(), counted);

  if (!counted) {
    console.log(`⚠️ Join NÃO contado (suspeito) member=${member.id} via ${used.code} inviter=${inviterId}`);
    return;
  }

  incInviter.run(inviterId);
  const count = getInviterCount.get(inviterId)?.real_joins ?? 0;

  await syncInviterRank(guild, inviterId, count);

  console.log(`+1 REAL para ${inviterId} (agora ${count}) via invite ${used.code}`);
});

/**
 * =========================
 * Member Leave -> optional auto remove if left too fast
 * =========================
 */
client.on(Events.GuildMemberRemove, async (member) => {
  if (member.guild.id !== GUILD_ID) return;

  const row = getJoinRow.get(member.id);
  if (!row) return;

  if (row.counted_real !== 1) return;
  if (row.reversed === 1) return;

  if (!leftTooFast(row.joined_at)) return;

  decInviter.run(row.inviter_id);
  markReversed.run(member.id);

  const guild = member.guild;
  const count = getInviterCount.get(row.inviter_id)?.real_joins ?? 0;
  await syncInviterRank(guild, row.inviter_id, count);

  console.log(`-1 (saiu rápido) para ${row.inviter_id} (agora ${count})`);
});

client.login(TOKEN);
