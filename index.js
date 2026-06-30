const { Telegraf, Scenes, session } = require('telegraf');
const express = require('express');
const { MongoClient } = require('mongodb');

// 1. Initialize MongoDB Client
const client = new MongoClient(process.env.MONGO_URI);
let db, usersCollection;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('telegram_bot'); // Your database name
    usersCollection = db.collection('users'); // Your collection name
    console.log("Connected successfully to MongoDB Atlas");
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}
connectDB();

// 2. Initialize Telegram Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// 3. Define the Registration Wizard Steps
const registrationWizard = new Scenes.WizardScene(
  'registration-wizard',
  // Step 1: Prompt for Email
  async (ctx) => {
    await ctx.reply("Welcome to registration! Please reply with your Email address:");
    ctx.wizard.state.userData = {}; // Temp store for answers
    return ctx.wizard.next();
  },
  // Step 2: Handle Email & Prompt for System ID
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      return ctx.reply("Please send a valid text email.");
    }
    ctx.wizard.state.userData.email = ctx.message.text;
    await ctx.reply("Got it. Now, please reply with your System ID number:");
    return ctx.wizard.next();
  },
  // Step 3: Handle System ID and Save to MongoDB
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      return ctx.reply("Please send a valid System ID.");
    }

    const systemId = ctx.message.text;
    const email = ctx.wizard.state.userData.email;
    const telegramId = ctx.from.id;
    const username = ctx.from.username || 'unknown';

    await ctx.reply("Saving your details... please wait.");

    try {
      // Insert document into MongoDB
      await usersCollection.updateOne(
        { telegram_id: telegramId }, // Search by Telegram ID
        { 
          $set: { 
            telegram_id: telegramId,
            username: username,
            email: email,
            system_id: systemId,
            registered_at: new Date()
          } 
        },
        { upsert: true } // If user exists, update them; if not, insert them
      );

      await ctx.reply("🎉 Registration successful! Your profile is saved.");
    } catch (error) {
      console.error(error);
      await ctx.reply("Oops! Something went wrong saving your data to MongoDB.");
    }

    return ctx.scene.leave(); // End the multi-step form session
  }
);

// 4. Register Session & Wizard Middleware
const stage = new Scenes.Stage([registrationWizard]);
bot.use(session()); // Local in-memory session management
bot.use(stage.middleware());

// Commands
bot.command('start', (ctx) => ctx.reply('Hi! Type /register to start setting up your profile.'));
bot.command('register', (ctx) => ctx.scene.enter('registration-wizard'));

// 5. Express Integration for Webhook
const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL; // Provided automatically by Render

app.use(bot.webhookCallback('/telegram-webhook'));

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (WEBHOOK_URL) {
    await bot.telegram.setWebhook(`${WEBHOOK_URL}/telegram-webhook`);
    console.log(`Telegram webhook configured to: ${WEBHOOK_URL}`);
  }
});
