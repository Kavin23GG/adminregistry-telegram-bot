const { Telegraf, Scenes, session } = require('telegraf');
const express = require('express');
const { MongoClient } = require('mongodb');

// 1. Initialize MongoDB
const client = new MongoClient(process.env.MONGO_URI);
let db, devicesCollection;

const activeCaregiverBots = new Map();
const MAX_CAREGIVERS = 5; // Set your limit here

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

// 3. Phase 1: Robust Registration Steps on the Main Bot
const registrationWizard = new Scenes.WizardScene(
  'registration-wizard',
  
  // Step 1: Prompt for Caregiver Name
  async (ctx) => {
    await ctx.reply("Welcome to AidBand Registration!\n\n⚠️ First, create a custom bot using @BotFather and copy the API Token.\n\nNow, enter YOUR name (Caregiver Name):");
    ctx.wizard.state.userData = {};
    return ctx.wizard.next();
  },
  
  // Step 2: Prompt for Patient Name
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please enter a valid name.");
    ctx.wizard.state.userData.caregiverName = ctx.message.text;
    await ctx.reply("Thank you. Please enter the PATIENT'S name:");
    return ctx.wizard.next();
  },
  
  // Step 3: Prompt for Device ID
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please enter a valid name.");
    ctx.wizard.state.userData.patientName = ctx.message.text;
    await ctx.reply("Please enter the unique AidBand DEVICE ID:");
    return ctx.wizard.next();
  },

  // Step 4: Point of No Return Confirmation
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please enter a valid Device ID.");
    ctx.wizard.state.userData.deviceId = ctx.message.text.toUpperCase().trim();
    
    const { caregiverName, patientName, deviceId } = ctx.wizard.state.userData;
    
    await ctx.reply(
      `⚠️ **CONFIRMATION REQUIRED** ⚠️\n\n` +
      `Caregiver: ${caregiverName}\n` +
      `Patient: ${patientName}\n` +
      `Device ID: ${deviceId}\n\n` +
      `Are you sure these details are correct? **You cannot undo or change this after this step.**\n\n` +
      `Reply with **YES** to confirm, or **NO** to cancel.`
    );
    return ctx.wizard.next();
  },

  // Step 5: Handle Confirmation & Ask for Bot Token
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please type YES or NO.");
    const answer = ctx.message.text.toUpperCase().trim();

    if (answer !== 'YES') {
      await ctx.reply("❌ Registration cancelled. Type /register to start over.");
      return ctx.scene.leave();
    }

    await ctx.reply("Details locked! Now, please paste your custom Bot Token from @BotFather:");
    return ctx.wizard.next();
  },

  // Step 6: Validate Token, Setup Webhook, & Stage MongoDB entry
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please send a valid token.");
    const customToken = ctx.message.text.trim();
    const { caregiverName, patientName, deviceId } = ctx.wizard.state.userData;
    const mainBotChatId = ctx.from.id;

    await ctx.reply("Validating bot token with Telegram servers... please wait.");

    // --- LIVE TOKEN VERIFICATION LOOP ---
    try {
      // Test if token can initialize and communicate with Telegram
      const testBot = new Telegraf(customToken);
      await testBot.telegram.getMe(); 
      // If it reaches here, the token is 100% working and valid!
    } catch (tokenError) {
      console.error("Token verification failed:", tokenError.message);
      await ctx.reply("❌ **INVALID BOT TOKEN.** Telegram rejected this token. Please check your BotFather copy-paste string and type /register to start again.");
      return ctx.scene.leave();
    }

    try {
      // Save data as PENDING
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

      // Now spawn the real background webhook route safely
      await setupCaregiverBotWebhook(customToken);

      await ctx.reply(
        `⏳ **Bot Validated & Token Staged!**\n\n` +
        `👉 **FINAL STEP:** Go open your custom bot right now and click **START**.\n\n` +
        `Once your custom bot registers your handshake chat ID, setup will complete successfully.`
      );

    } catch (error) {
      console.error(error);
      await ctx.reply("An error occurred during database setup.");
    }
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([registrationWizard]);
mainRegistryBot.use(session());
mainRegistryBot.use(stage.middleware());

mainRegistryBot.command('start', (ctx) => ctx.reply("Welcome to AidBand! Type /register to initiate device configuration."));
mainRegistryBot.command('register', (ctx) => ctx.scene.enter('registration-wizard'));

// 4. Phase 2: Handshake Verification & MAX CAREGIVER LIMIT Checked here
async function setupCaregiverBotWebhook(token) {
  if (activeCaregiverBots.has(token)) return;

  const cBot = new Telegraf(token);

  cBot.command('start', async (ctx) => {
    const customBotChatId = ctx.from.id;

    try {
      const device = await devicesCollection.findOne({ bot_token: token });

      if (!device) {
        return ctx.reply("This bot is not paired with a device configuration. Please open the Main Registry Bot.");
      }

      // --- MAX CAREGIVER LIMIT CHECK ---
      if (device.caregivers && device.caregivers.length >= MAX_CAREGIVERS) {
        // Check if this specific user is trying to re-register (allow updates, block new users)
        const isAlreadyRegistered = device.caregivers.some(c => c.telegram_id === customBotChatId);
        if (!isAlreadyRegistered) {
          return ctx.reply(`❌ **Registration Limit Reached:** This device has already reached its limit of ${MAX_CAREGIVERS} registered caregivers.`);
        }
      }

      let caregiverName = ctx.from.first_name || 'Caregiver';
      let username = ctx.from.username || 'unknown';

      if (device.status === "PENDING" && device.pending_caregiver) {
        caregiverName = device.pending_caregiver.caregiver_name;
        username = device.pending_caregiver.username;
      }

      const caregiverData = {
        telegram_id: customBotChatId,
        username: username,
        caregiver_name: caregiverName
      };

      await devicesCollection.updateOne(
        { bot_token: token },
        { 
          $set: { status: "ACTIVE", last_updated: new Date() },
          $addToSet: { caregivers: caregiverData },
          $unset: { registration_initiator_chat_id: "", pending_caregiver: "" } 
        }
      );

      await ctx.reply(
        `🎉 **Successfully Linked!**\n\n` +
        `Device ID: [${device.device_id}]\n` +
        `Patient Name: ${device.patient_name}\n\n` +
        `You are now an authorized recipient of critical monitoring broadcasts.`
      );

      if (device.status === "PENDING" && device.registration_initiator_chat_id) {
        try {
          await mainRegistryBot.telegram.sendMessage(
            device.registration_initiator_chat_id,
            `✅ **Device Activation Confirmed!** Handshake verified successfully for Device [${device.device_id}].`
          );
        } catch (err) {
          console.log("Could not contact main bot chat channel.");
        }
      }

    } catch (error) {
      console.error("Handshake loop failure:", error);
      return ctx.reply("An error occurred during network linking.");
    }
  });

  activeCaregiverBots.set(token, cBot);

  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    await cBot.telegram.setWebhook(`${RENDER_URL}/webhook/${token}`);
    console.log(`🔗 Webhook armed for bot: ...${token.slice(-6)}`);
  }
}

async function loadExistingCaregiverBots() {
  const devices = await devicesCollection.find({ bot_token: { $exists: true } }).toArray();
  const uniqueTokens = [...new Set(devices.map(d => d.bot_token))];
  for (const token of uniqueTokens) {
    try {
      await setupCaregiverBotWebhook(token);
    } catch (e) {
      console.error(`Error loading token stream:`, e.message);
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
  console.log(`Server executing cleanly on port ${PORT}`);
  if (process.env.RENDER_EXTERNAL_URL) {
    await mainRegistryBot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/main-webhook`);
  }
});
