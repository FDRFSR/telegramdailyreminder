// Migliorato: gestione errori, struttura funzioni, commenti best practice
const { Telegraf, Markup } = require('telegraf');
require('dotenv').config();
const constants = require('./config/constants');
const TaskService = require('./services/taskService');
const { validateTaskText, checkRateLimit } = require('./utils/validation');
const logger = require('./utils/logger');
const taskService = new TaskService();

if (!process.env.TELEGRAM_BOT_TOKEN) {
  logger.error("TELEGRAM_BOT_TOKEN environment variable is not set");
  console.error("Errore: la variabile d'ambiente TELEGRAM_BOT_TOKEN non è impostata.");
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const userStates = Object.create(null);

// Salva i messaggi inviati per ogni utente
const sentMessages = Object.create(null); // { userId: [messageId, ...] }

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Crea Task', 'CREATE_TASK')],
    [Markup.button.callback('📋 Visualizza Lista', 'SHOW_LIST')]
  ]);
}

/**
 * Main menu reply keyboard
 * @returns {Markup.Markup}
 */
function mainMenuKeyboard() {
  return Markup.keyboard([
    ['➕ Crea Task', '📋 Visualizza Lista']
  ]).resize().oneTime(false);
}

/**
 * Get the user's task list
 * @param {number|string} userId
 * @returns {Array}
 */
function getTaskList(userId) {
  return taskService.getTaskList(userId);
}

/**
 * Track sent messages for later deletion
 * @param {import('telegraf').Context} ctx
 * @param {Promise} replyPromise
 */
async function trackMessage(ctx, replyPromise) {
  try {
    const userId = ctx.from.id;
    const msg = await replyPromise;
    if (!sentMessages[userId]) sentMessages[userId] = [];
    sentMessages[userId].push({ id: msg.message_id, date: Date.now(), chatId: msg.chat.id, chatType: msg.chat.type });
  } catch (error) {
    logger.error('Error tracking message', { error: error.message, userId: ctx.from?.id });
  }
}

/**
 * Consistent reply and track function
 */
function replyAndTrack(ctx, ...args) {
  return trackMessage(ctx, ctx.reply(...args));
}

/**
 * Clean up old messages (opt: batch delete, memory cleanup)
 */
async function cleanOldMessages() {
  const now = Date.now();
  const tenMinutes = constants.MESSAGE_LIFETIME;
  for (const userId in sentMessages) {
    if (!Array.isArray(sentMessages[userId]) || sentMessages[userId].length === 0) {
      delete sentMessages[userId];
      continue;
    }
    // Only keep messages < 10min old
    const userMsgs = sentMessages[userId];
    const toDelete = [];
    let keep = [];
    for (const m of userMsgs) {
      if (now - m.date >= tenMinutes) toDelete.push(m);
      else keep.push(m);
    }
    sentMessages[userId] = keep;
    for (const msg of toDelete) {
      try {
        await bot.telegram.deleteMessage(msg.chatId, msg.id);
      } catch (e) {
        // Ignore errors (already deleted, etc.)
      }
    }
    if (sentMessages[userId].length === 0) delete sentMessages[userId];
  }
  
  // Clean up inactive user states (older than 1 hour)
  const oneHour = 60 * 60 * 1000;
  for (const userId in userStates) {
    if (userStates[userId] && typeof userStates[userId] === 'object' && userStates[userId].timestamp) {
      if (now - userStates[userId].timestamp > oneHour) {
        delete userStates[userId];
      }
    }
  }
}

setInterval(cleanOldMessages, constants.CLEANUP_INTERVAL);

// --- BOT HANDLERS ---

bot.start((ctx) => {
  userStates[ctx.from.id] = null;
  replyAndTrack(ctx, '👋 Benvenuto! Usa i tasti qui sotto per gestire le tue task. Buona produttività!', mainMenuKeyboard());
});

bot.hears('➕ Crea Task', (ctx) => {
  if (!checkRateLimit(ctx.from.id, 'general')) {
    return replyAndTrack(ctx, '⏰ Stai andando troppo veloce! Aspetta un momento.');
  }
  userStates[ctx.from.id] = 'AWAITING_TASK';
  replyAndTrack(ctx, '✍️ Scrivi la task da aggiungere oppure /annulla per tornare al menu.', mainMenuKeyboard());
});

bot.hears('📋 Visualizza Lista', (ctx) => {
  if (!checkRateLimit(ctx.from.id, 'general')) {
    return replyAndTrack(ctx, '⏰ Stai andando troppo veloce! Aspetta un momento.');
  }
  showTaskList(ctx, { withMenuButtons: true, useReply: true });
});

bot.action('CREATE_TASK', (ctx) => {
  userStates[ctx.from.id] = 'AWAITING_TASK';
  replyAndTrack(ctx, 'Scrivi la task da aggiungere oppure /annulla per tornare al menu.');
});

bot.hears(/\/annulla/i, (ctx) => {
  userStates[ctx.from.id] = null;
  replyAndTrack(ctx, '❌ Operazione annullata. Sei tornato al menu principale.', mainMenu());
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  
  // Rate limiting check
  if (!checkRateLimit(userId, 'add_task')) {
    return replyAndTrack(ctx, '⏰ Stai andando troppo veloce! Aspetta un momento prima di aggiungere altre task.');
  }
  
  if (userStates[userId] !== 'AWAITING_TASK') return;
  
  const text = ctx.message.text.trim();
  
  // Enhanced validation
  const validation = validateTaskText(text);
  if (!validation.isValid) {
    return replyAndTrack(ctx, `⚠️ ${validation.error} Riprova o usa /annulla.`);
  }
  
  if (text.startsWith('/')) {
    return replyAndTrack(ctx, '⚠️ La task non può essere un comando. Riprova o usa /annulla.');
  }
  
  try {
    await taskService.addTask(userId, text);
    userStates[userId] = null;
    logger.info('Task added successfully', { userId, taskLength: text.length });
    replyAndTrack(ctx, '✅ Task aggiunta con successo! Continua così!', mainMenu());
  } catch (error) {
    logger.error('Error adding task', { error: error.message, userId });
    replyAndTrack(ctx, '❌ Errore nel salvare la task. Riprova.');
  }
});

bot.action('SHOW_LIST', (ctx) => {
  showTaskList(ctx, { withMenuButtons: true, useReply: true });
});

bot.action('BACK_TO_MENU', (ctx) => {
  replyAndTrack(ctx, '🔙 Tornato al menu principale.', mainMenu());
});

bot.action(/COMPLETE_(.+)/, async (ctx) => {
  const taskId = ctx.match[1];
  const userId = ctx.from.id;
  let userTasks = taskService.getTaskList(userId);
  if (!Array.isArray(userTasks) || userTasks.length === 0) {
    await replyAndTrack(ctx, '🎉 Nessuna task attiva! Goditi il tuo tempo libero.', mainMenu());
    return;
  }
  // Remove the completed task
  try {
    await taskService.removeTask(userId, taskId);
    userTasks = taskService.getTaskList(userId);
    try {
      await ctx.answerCbQuery('🗑️ Task eliminata! Una in meno da fare.');
    } catch (e) {}
    // Refresh list and handle empty case
    userTasks = sortTasks(userTasks);
    if (userTasks.length === 0) {
      try {
        await ctx.editMessageText('🎉 Nessuna task attiva! Goditi il tuo tempo libero.', mainMenu());
      } catch (e) {
        replyAndTrack(ctx, '🎉 Nessuna task attiva! Goditi il tuo tempo libero.', mainMenu());
      }
    } else {
      try {
        await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(taskButtons(userTasks)).reply_markup);
      } catch (e) {
        replyAndTrack(ctx, 'Le tue task:', Markup.inlineKeyboard(taskButtons(userTasks)));
      }
    }
  } catch (error) {
    logger.error('Error removing task', { error: error.message, userId, taskId });
    await ctx.answerCbQuery('❌ Errore nell\'eliminare la task.');
  }
});

bot.action(/PRIORITY_(.+)/, async (ctx) => {
  const taskId = ctx.match[1];
  const userId = ctx.from.id;
  try {
    await taskService.togglePriority(userId, taskId);
    try {
      await ctx.answerCbQuery('🌟 Task marcata come prioritaria!');
    } catch (e) {}
    // Refresh lista
    let userTasks = taskService.getTaskList(userId);
    userTasks = sortTasks(userTasks);
    const buttons = taskButtons(userTasks);
    if (ctx.update.callback_query.message.reply_markup.inline_keyboard.some(row => row.some(btn => btn.text === '➕ Nuova Task'))) {
      buttons.push([
        Markup.button.callback('➕ Nuova Task', 'CREATE_TASK'),
        Markup.button.callback('🔙 Menu', 'BACK_TO_MENU')
      ]);
    }
    try {
      await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(buttons).reply_markup);
    } catch (e) {
      replyAndTrack(ctx, 'Le tue task:', Markup.inlineKeyboard(buttons));
    }
  } catch (error) {
    logger.error('Error toggling priority', { error: error.message, userId, taskId });
    await ctx.answerCbQuery('❌ Errore nel cambiare la priorità.');
  }
});

function truncateText(text, maxLength = 30) {
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

function taskButtons(userTasks) {
  return userTasks.map(task => [
    Markup.button.callback(`${task.priority ? '🌟' : '⭐'} ${truncateText(task.text)}`, `DELETE_CONFIRM_${task.id}`),
    Markup.button.callback(task.priority ? '⬇️' : '⬆️', `PRIORITY_${task.id}`)
  ]);
}

bot.action(/DELETE_CONFIRM_(.+)/, async (ctx) => {
  const taskId = ctx.match[1];
  const userId = ctx.from.id;
  const userTasks = taskService.getTaskList(userId);
  const task = userTasks.find(t => t.id === taskId);
  if (!task) {
    await ctx.answerCbQuery('Task non trovata.');
    return;
  }
  await ctx.editMessageText(
    `Sei sicuro di voler eliminare questa task?\n\n${truncateText(task.text, 50)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Sì', `COMPLETE_${taskId}`)],
      [Markup.button.callback('❌ No', 'CANCEL_DELETE')]
    ])
  );
});

bot.action('CANCEL_DELETE', async (ctx) => {
  await showTaskList(ctx, { withMenuButtons: false, useReply: false });
});

/**
 * Visualizza la lista delle task per l'utente
 * @param {import('telegraf').Context} ctx
 * @param {boolean} withMenuButtons - se true, aggiunge i bottoni Nuova Task/Menu
 * @param {boolean} useReply - se true, usa replyAndTrack, altrimenti editMessageText
 */
async function showTaskList(ctx, { withMenuButtons = false, useReply = true } = {}) {
  const userId = ctx.from.id;
  let userTasks = taskService.getTaskList(userId);
  userTasks = sortTasks(userTasks);
  if (!Array.isArray(userTasks) || userTasks.length === 0) {
    const msg = '🎉 Nessuna task attiva! Goditi il tuo tempo libero.';
    if (useReply) return replyAndTrack(ctx, msg, mainMenuKeyboard());
    else return ctx.editMessageText(msg, mainMenu());
  }
  const buttons = taskButtons(userTasks);
  if (withMenuButtons) {
    buttons.push([
      Markup.button.callback('➕ Nuova Task', 'CREATE_TASK'),
      Markup.button.callback('🔙 Menu', 'BACK_TO_MENU')
    ]);
  }
  if (useReply) {
    return replyAndTrack(ctx, 'Le tue task:', Markup.inlineKeyboard(buttons));
  } else {
    return ctx.editMessageText('Le tue task:', Markup.inlineKeyboard(buttons));
  }
}

/**
 * Send reminders every 30 minutes except 22-08
 */
function sendReminders() {
  const now = new Date();
  const hour = now.getHours();
  if (hour >= constants.QUIET_HOURS.start || hour < constants.QUIET_HOURS.end) return;
  for (const userId in taskService.tasks) {
    const userTasks = taskService.getTaskList(userId);
    if (userTasks.length > 0) {
      bot.telegram.sendMessage(
        userId,
        '⏰ Reminder! Hai ancora queste task da completare:\n' +
          sortTasks(userTasks).map(t => `${t.priority ? '🌟' : '⭐'} ${t.text}`).join('\n'),
        mainMenuKeyboard()
      ).catch(() => {});
    }
  }
}
setInterval(sendReminders, constants.REMINDER_INTERVAL);

bot.launch().then(() => {
  logger.info('Bot started successfully');
  console.log('✅ Bot started and listening for updates!');
}).catch((err) => {
  logger.error('Error starting bot', { error: err.message });
  console.error('Errore durante l\'avvio del bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
}
