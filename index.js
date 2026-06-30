const { Telegraf, Scenes, session } = require('telegraf');
const express = require('express');
const { MongoClient } = require('mongodb');

// 1. Initialize MongoDB
const client = new MongoClient(process.env.MONGO_URI);
let db, devicesCollection;

const activeCaregiverBots = new Map();

async function connectDB() {
  try {
    await client.connect();
    db = client.db('Device_Registry'); 
    devicesCollection = db.collection('Devices'); 
    console.log("Connected successfully to MongoDB Atlas");
    await loadExistingCaregiverBots();
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}
connectDB();

// 2. Initialize the Main Registry Bot
const mainRegistryBot = new Telegraf(process.env.MAIN_BOT_TOKEN);

// 3. Phase 1: Registration Steps on the Main Bot
const registrationWizard = new Scenes.WizardScene(
  'registration-wizard',
  async (ctx) => {
    await ctx.reply("Welcome to AidBand Registration!\n\n⚠️ First, create a custom bot using @BotFather and copy the API Token.\n\nNow, enter YOUR name (Caregiver Name):");
    ctx.wizard.state.userData = {};
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please enter a valid name.");
    ctx.wizard.state.userData.caregiverName = ctx.message.text;
    await ctx.reply("Thank you. Please enter the PATIENT'S name:");
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please enter a valid name.");
    ctx.wizard.state.userData.patientName = ctx.message.text;
    await ctx.reply("Please enter the unique AidBand DEVICE ID:");
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please enter a valid Device ID.");
    ctx.wizard.state.userData.deviceId = ctx.message.text.toUpperCase().trim();
    await ctx.reply("Perfect! Finally, paste your custom Bot Token from @BotFather:");
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please send a valid token.");
    const customToken = ctx.message.text.trim();
    const { caregiverName, patientName, deviceId } = ctx.wizard.state.userData;
    const mainBotChatId = ctx.from.id; // Save this to notify them here later

    await ctx.reply("Saving configuration parameters... please wait.");

    try {
      // Save data as PENDING. Do not add to caregivers array yet.
      await devicesCollection.updateOne(
        { device_id: deviceId },
        { 
          $set: { 
            patient_name: patientName, 
            bot_token: customToken, 
            status: "PENDING",
            registration_initiator_chat_id: mainBotChatId,
            pending_caregiver: {
              username: ctx.from.username || 'unknown',
              caregiver_name: caregiverName
            },
            last_updated: new Date() 
          }
        },
        { upsert: true }
      );

      // Spin up the webhook routing for the custom bot
      await setupCaregiverBotWebhook(customToken);

      // Extract username from token to build an easy-click link if possible, or just instruct them
      await ctx.reply(
        `⏳ **Configuration saved! Connection Pending...**\n\n` +
        `👉 **CRITICAL NEXT STEP:** Open your custom bot right now and click **START** (or send /start).\n\n` +
        `Once your custom bot verifies your Chat ID, registration will finalize.`
      );

    } catch (error) {
      console.error(error);
      await ctx.reply("An error occurred during staging.");
    }
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([registrationWizard]);
mainRegistryBot.use(session());
mainRegistryBot.use(stage.middleware());

mainRegistryBot.command('start', (ctx) => ctx.reply("Welcome to AidBand! Type /register to stage your device setup."));
mainRegistryBot.command('register', (ctx) => ctx.scene.enter('registration-wizard'));

// 4. Phase 2: Handshake verification on Custom Bot
async function setupCaregiverBotWebhook(token) {
  if (activeCaregiverBots.has(token)) return;

  const cBot = new Telegraf(token);

  cBot.command('start', async (ctx) => {
    const customBotChatId = ctx.from.id;

    try {
      // Find the device currently pending for this specific bot token
      const device = await devicesCollection.findOne({ bot_token: token });

      if (!device) {
        return ctx.reply("This bot is not staged for an active AidBand device. Please register via the Main Registry Bot first.");
      }

      // Prepare caregiver schema
      let caregiverName = ctx.from.first_name || 'Caregiver';
      let username = ctx.from.username || 'unknown';

      // If this is the initial registrar, use the clean name they provided in the Main Bot wizard
      if (device.status === "PENDING" && device.pending_caregiver) {
        caregiverName = device.pending_caregiver.caregiver_name;
        username = device.pending_caregiver.username;
      }

      const caregiverData = {
        telegram_id: customBotChatId,
        username: username,
        caregiver_name: caregiverName
      };

      // Update Database: set to ACTIVE and clear pending object
      await devicesCollection.updateOne(
        { bot_token: token },
        { 
          $set: { status: "ACTIVE", last_updated: new Date() },
          $addToSet: { caregivers: caregiverData },
          $unset: { registration_initiator_chat_id: "", pending_caregiver: "" } 
        }
      );

      // Send Success message on Custom Bot
      await ctx.reply(
        `🎉 **Successfully Registered & Verified!**\n\n` +
        `Device ID: [${device.device_id}]\n` +
        `Patient Name: ${device.patient_name}\n\n` +
        `This custom bot is now officially active. Secure medical alerts will be broadcasted to this chat.`
      );

      // Notify them on the Main Bot too if it was a fresh setup!
      if (device.status === "PENDING" && device.registration_initiator_chat_id) {
        try {
          await mainRegistryBot.telegram.sendMessage(
            device.registration_initiator_chat_id,
            `✅ **Registration Finalized!** Your custom bot has successfully handshake-verified your Chat ID for Device [${device.device_id}]. Setup complete.`
          );
        } catch (err) {
          console.log("Could not send confirmation back to main bot chat (user may have cleared history).");
        }
      }

    } catch (error) {
      console.error("Verification handshake failed:", error);
      return ctx.reply("An error occurred during verification handshake.");
    }
  });

  activeCaregiverBots.set(token, cBot);

  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    await cBot.telegram.setWebhook(`${RENDER_URL}/webhook/${token}`);
    console.log(`🔗 Webhook active for bot: ...${token.slice(-6)}`);
  }
}

async function loadExistingCaregiverBots() {
  const devices = await devicesCollection.find({ bot_token: { $exists: true } }).toArray();
  const uniqueTokens = [...new Set(devices.map(d => d.bot_token))];
  for (const token of uniqueTokens) {
    try {
      await setupCaregiverBotWebhook(token);
    } catch (e) {
      console.error(`Error reloading bot token:`, e.message);
    }
  }
}

// 5. Express Routing
const app = express();
app.use(express.json());

app.use(mainRegistryBot.webhookCallback('/main-webhook'));

app.post('/webhook/:token', (req, res, next) => {
  const { token } = req.params;
  const cBot = activeCaregiverBots.get(token);
  if (cBot) {
    return cBot.webhookCallback(`/webhook/${token}`)(req, res, next);
  } else {
    return res.status(404).send('Bot instance offline.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.RENDER_EXTERNAL_URL) {
    await mainRegistryBot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/main-webhook`);
  }
});
