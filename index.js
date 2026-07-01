const { Telegraf, Scenes, session } = require('telegraf');
const express = require('express');
const { MongoClient } = require('mongodb');

// 1. Initialize MongoDB Configuration
const client = new MongoClient(process.env.MONGO_URI);
let db, devicesCollection;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('Device_Registry'); 
    devicesCollection = db.collection('Devices'); 
    console.log("Connected securely to MongoDB Atlas");
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}
connectDB();

// 2. Initialize your ONE Master Bot Instance
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// 3. The Onboarding Wizard Scene (Enforced in Private Chat Only)
const registrationWizard = new Scenes.WizardScene(
  'registration-wizard',
  
  // Step 1: Prompt for Caregiver Name
  async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply("❌ Please run the /register command in a private chat with me, not inside a group.");
      return ctx.scene.leave();
    }
    await ctx.reply("Welcome to AidBand! Let's link your wristband.\n\nPlease enter YOUR name (Caregiver Name):");
    ctx.wizard.state.userData = {};
    return ctx.wizard.next();
  },
  
  // Step 2: Receive Caregiver Name & Prompt for Patient Name
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please enter a valid name.");
    ctx.wizard.state.userData.caregiverName = ctx.message.text.trim();
    
    await ctx.reply("Thank you. Please enter the PATIENT'S name:");
    return ctx.wizard.next();
  },
  
  // Step 3: Receive Patient Name & Prompt for Device ID
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please enter a valid name.");
    ctx.wizard.state.userData.patientName = ctx.message.text.trim();
    
    await ctx.reply("Please enter the unique AidBand DEVICE ID:");
    return ctx.wizard.next();
  },

  // Step 4: Receive Device ID, Run Hard Duplicate Check & Request Confirmation
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please enter a valid Device ID.");
    const inputId = ctx.message.text.toUpperCase().trim();

    await ctx.reply("Checking device availability... please wait.");

    try {
      // 🔒 Duplicate Check: Prevent multi-registrations of the same physical hardware ID
      const deviceExists = await devicesCollection.findOne({ device_id: inputId });

      if (deviceExists) {
        await ctx.reply(`❌ **REGISTRATION FAILED:** Device ID [${inputId}] is already registered in our system for another user.\n\nSetup stopped.`);
        return ctx.scene.leave(); 
      }

      // Save Device ID temporarily into wizard context memory
      ctx.wizard.state.userData.deviceId = inputId;
      const { caregiverName, patientName } = ctx.wizard.state.userData;

      // Ask user to verify information explicitly
      await ctx.reply(
        `⚠️ **CONFIRMATION REQUIRED** ⚠️\n\n` +
        `Please verify if your information is correct:\n` +
        `• **Caregiver Name:** ${caregiverName}\n` +
        `• **Patient Name:** ${patientName}\n` +
        `• **Device ID:** [${inputId}]\n\n` +
        `Reply with **YES** to save and proceed, or **NO** to cancel.`
      );
      
      return ctx.wizard.next();

    } catch (err) {
      console.error("Database availability check failed:", err);
      await ctx.reply("A system checking error occurred. Please type /register to start over.");
      return ctx.scene.leave();
    }
  },

  // Step 5: Evaluate confirmation. If YES, write to MongoDB.
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply("Please reply with YES or NO.");
    const answer = ctx.message.text.toUpperCase().trim();

    if (answer !== 'YES') {
      await ctx.reply("❌ Registration cancelled. Your settings were not saved. Type /register if you want to start over.");
      return ctx.scene.leave();
    }

    // Process Database Write
    const { caregiverName, patientName, deviceId } = ctx.wizard.state.userData;
    const telegramUserId = ctx.from.id;

    try {
      await devicesCollection.updateOne(
        { device_id: deviceId },
        {
          $set: {
            patient_name: patientName,
            status: "PENDING_GROUP_ADD",
            creator_telegram_id: telegramUserId,
            group_chat_id: null, // Populated down during step 5
            registered_by: {
              telegram_id: telegramUserId,
              username: ctx.from.username || 'unknown',
              caregiver_name: caregiverName
            },
            last_updated: new Date()
          }
        },
        { upsert: true }
      );

      await ctx.reply(
        `✅ **Registration Initiated Successfully!**\n\n` +
        `👉 **FINAL STEP:** Go create your Family Group Chat inside Telegram, add all relevant caregivers/nurses, and **invite this bot into that group.**\n\n` +
        `When I join, I will automatically lock onto that group chat identifier and activate live monitoring broadcasts.`
      );

    } catch (err) {
      console.error("Failed writing profile to MongoDB database:", err);
      await ctx.reply("A database execution error occurred while processing storage logic.");
    }
    
    return ctx.scene.leave();
  }
);

// 4. Register Scenes Middleware
const stage = new Scenes.Stage([registrationWizard]);
bot.use(session());
bot.use(stage.middleware());

bot.command('start', (ctx) => ctx.reply("Welcome to AidBand monitoring! Type /register to configure your device."));
bot.command('register', (ctx) => ctx.scene.enter('registration-wizard'));

// 5. Automated Group Chat Capture Event Listener
bot.on('new_chat_members', async (ctx) => {
  const groupChatId = ctx.chat.id; 
  const myBotInfo = await bot.telegram.getMe();

  const botWasAdded = ctx.message.new_chat_members.some(member => member.id === myBotInfo.id);

  if (botWasAdded) {
    const userWhoAddedMe = ctx.from.id; 

    try {
      const pendingDevice = await devicesCollection.findOne({
        creator_telegram_id: userWhoAddedMe,
        status: "PENDING_GROUP_ADD"
      });

      if (!pendingDevice) {
        return ctx.reply("⚠️ Hello Caregivers! I was added to this group, but I couldn't find a pending registration from the person who invited me. Please complete registration in my DMs via /register.");
      }

      await devicesCollection.updateOne(
        { _id: pendingDevice._id },
        {
          $set: {
            group_chat_id: groupChatId,
            status: "ACTIVE",
            last_updated: new Date()
          }
        }
      );

      await ctx.reply(
        `🎉 **Care Circle Activated!**\n\n` +
        `• **Patient Name:** ${pendingDevice.patient_name}\n` +
        `• **Primary Nurse/Caregiver:** ${pendingDevice.registered_by.caregiver_name}\n` +
        `• **Device ID:** [${pendingDevice.device_id}]\n\n` +
        `This group chat is officially linked. Critical biometric alert data for falls and irregular heart rates will broadcast here.`
      );

    } catch (err) {
      console.error("Group intercept assignment tracking failure:", err);
    }
  }
});

// 6. Production Express Webhook Server Setup for Render
const app = express();
app.use(express.json());

app.use(bot.webhookCallback('/telegram-webhook'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Master Bot Process initialized and online!");
  if (process.env.RENDER_EXTERNAL_URL) {
    await bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/telegram-webhook`);
    console.log("🔗 Webhook synchronized cleanly with Render!");
  }
});
