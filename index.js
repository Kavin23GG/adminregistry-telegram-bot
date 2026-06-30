const { Telegraf, Scenes, session } = require('telegraf');
const express = require('express');
const { MongoClient } = require('mongodb');

// 1. Initialize MongoDB
const client = new MongoClient(process.env.MONGO_URI);
let db, devicesCollection;

const activeCaregiverBots = new Map();
const MAX_CAREGIVERS = 5; 

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

// 3. Phase 1: Robust Registration Wizard Steps on the Main Bot
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

  // Step 4: Check if Device ID already Exists & Ask Confirmation
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please enter a valid Device ID.");
    const inputId = ctx.message.text.toUpperCase().trim();
    
    await ctx.reply("Checking device registry database... please wait.");

    try {
      const deviceExists = await devicesCollection.findOne({ device_id: inputId });

      if (deviceExists) {
        await ctx.reply(`❌ **ERROR:** Device ID [${inputId}] already exists in the system and is assigned to patient: ${deviceExists.patient_name}.\n\nRegistration stopped. Type /register to start over with a different ID.`);
        return ctx.scene.leave(); 
      }

      ctx.wizard.state.userData.deviceId = inputId;
      const { caregiverName, patientName } = ctx.wizard.state.userData;
      
      await ctx.reply(
        `⚠️ **CONFIRMATION REQUIRED** ⚠️\n\n` +
        `Caregiver Name: ${caregiverName}\n` +
        `Patient Name: ${patientName}\n` +
        `Device ID: ${inputId}\n\n` +
        `Are you sure these details are correct? **You cannot undo or change this after this step.**\n\n` +
        `Reply with **YES** to confirm, or **NO** to cancel.`
      );
      return ctx.wizard.next();

    } catch (dbError) {
      console.error("Error checking device existence:", dbError);
      await ctx.reply("An error occurred while communicating with the database. Please try again.");
      return ctx.scene.leave();
    }
  },

  // Step 5: Handle Confirmation Choice & Ask for Bot Token
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

  // Step 6: Validate Custom Token & Stage Database Object with Creator Tracking
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please send a valid token.");
    const customToken = ctx.message.text.trim();
    const { caregiverName, patientName, deviceId } = ctx.wizard.state.userData;
    const mainBotChatId = ctx.from.id;

    await ctx.reply("Validating bot token with Telegram servers... please wait.");

    try {
      const testBot = new Telegraf(customToken);
      await testBot.telegram.getMe(); 
    } catch (tokenError) {
      console.error("Token verification failed:", tokenError.message);
      await ctx.reply("❌ **INVALID BOT TOKEN.** Telegram rejected this token. Please check your BotFather string and type /register to start again.");
      return ctx.scene.leave();
    }

    try {
      // Save data configuration as PENDING setup and record creator_chat_id
      await devicesCollection.updateOne(
        { device_id: deviceId },
        { 
          $set: { 
            patient_name: patientName, 
            bot_token: customToken, 
            status: "PENDING",
            creator_chat_id: mainBotChatId, // Perma-tracks who owns the main bot registry
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

      await setupCaregiverBotWebhook(customToken);

      await ctx.reply(
        `⏳ **Bot Validated & Token Staged!**\n\n` +
        `👉 **FINAL STEP:** Go open your custom bot right now and click **START**.\n\n` +
        `Once your custom bot registers your handshake chat ID, setup will finalize.`
      );

    } catch (error) {
      console.error(error);
      await ctx.reply("An error occurred during database staging.");
    }
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([registrationWizard]);
mainRegistryBot.use(session());
mainRegistryBot.use(stage.middleware());

mainRegistryBot.command('start', (ctx) => ctx.reply("Welcome to AidBand! Type /register to initiate device configuration."));
mainRegistryBot.command('register', (ctx) => ctx.scene.enter('registration-wizard'));

// 4. Phase 2: Handshake Verification & Alerting Admin Bot of Join Requests
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

      // 1. DUPLICATE CHECK
      const isAlreadyRegistered = device.caregivers && device.caregivers.some(c => c.telegram_id === customBotChatId);

      if (isAlreadyRegistered) {
        return ctx.reply(
          `👋 **Welcome back!**\n\n` +
          `You are already actively registered to receive alerts for:\n` +
          `Device ID: [${device.device_id}]\n` +
          `Patient Name: ${device.patient_name}\n\n` +
          `Everything is working perfectly.`
        );
      }

      // 2. MAX LIMIT CHECK
      if (device.caregivers && device.caregivers.length >= MAX_CAREGIVERS) {
        return ctx.reply(`❌ **Registration Limit Reached:** This device has already reached its maximum allowance of ${MAX_CAREGIVERS} registered caregivers.`);
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

      // Update MongoDB safely
      await devicesCollection.updateOne(
        { bot_token: token },
        { 
          $set: { status: "ACTIVE", last_updated: new Date() },
          $addToSet: { caregivers: caregiverData },
          $unset: { registration_initiator_chat_id: "", pending_caregiver: "" } 
        }
      );

      // Confirm to the person who clicked start on the custom bot
      await ctx.reply(
        `🎉 **Successfully Linked!**\n\n` +
        `Device ID: [${device.device_id}]\n` +
        `Patient Name: ${device.patient_name}\n\n` +
        `You are now an authorized recipient of critical monitoring broadcasts from this bot.`
      );

      // --- NEW FEATURE: NOTIFY DEVICE ADMIN BOT OWNER ---
      const adminChatId = device.creator_chat_id || device.registration_initiator_chat_id;
      
      // Only ping if the person joining isn't the admin themselves!
      if (adminChatId && adminChatId !== customBotChatId) {
        try {
          await mainRegistryBot.telegram.sendMessage(
            adminChatId,
            `👤 **New Caregiver Registered!**\n\n` +
            `A new user has accessed your custom bot and linked to your device:\n` +
            `• **Name:** ${caregiverName}\n` +
            `• **Username:** @${username}\n` +
            `• **Chat ID:** ${customBotChatId}\n\n` +
            `**Device affected:** [${device.device_id}] (${device.patient_name})`
          );
        } catch (err) {
          console.error("Could not notify admin regarding join event:", err.message);
        }
      }

      // Initial validation response back to registration loop channel
      if (device.status === "PENDING" && device.registration_initiator_chat_id) {
        try {
          await mainRegistryBot.telegram.sendMessage(
            device.registration_initiator_chat_id,
            `✅ **Device Activation Confirmed!** Handshake verified successfully for Device [${device.device_id}].`
          );
        } catch (err) {
          console.log("Could not contact main bot channel.");
        }
      }

    } catch (error) {
      console.error("Handshake system error:", error);
      return ctx.reply("An error occurred during system network execution.");
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
      console.error(`Error loading token loop:`, e.message);
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
