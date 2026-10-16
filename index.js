import 'dotenv/config';
import readline from 'node:readline';
import Groq from 'groq-sdk';
import { connect, close } from './db.js';
import { toolDefinitions, runTool } from './tools.js';

const AGENT_NAME = 'MediSlot';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let isAdmin = false;
const messages = []; // conversation memory for this session

const GREETING = `Hello! I'm ${AGENT_NAME}, the virtual receptionist of CityCare Clinic. I can help you find a doctor, see free slots, and book, reschedule or cancel an appointment. How can I help?`;

function systemPrompt() {
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const calendar = Array.from({ length: 9 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    return `${days[d.getDay()]} ${fmt(d)}${i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : ''}`;
  }).join('\n');

  return `You are ${AGENT_NAME}, the friendly receptionist chatbot of CityCare Clinic. Introduce yourself as "${AGENT_NAME}" when greeting.

YOU CAN: list doctors, show free slots, register new patients, book / reschedule / cancel appointments, show a patient's appointments.${isAdmin ? ' ADMIN MODE IS ON: you may also show the daily schedule of all doctors.' : ' The daily schedule of all doctors is for clinic admin only - politely refuse.'}
YOU CANNOT: diagnose, name medicines, or give medical advice. You may only map symptoms to a department (e.g. skin rash -> Dermatology, toothache -> Dentistry, fever -> General Physician) and must add a short disclaimer like "I can't give medical advice, please talk to the doctor."

Today is ${days[now.getDay()]} ${fmt(now)}, time ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}.
Calendar (convert words like "tomorrow" or "Friday" using this):
${calendar}
Time of day: morning = before 12:00, afternoon = 12:00-17:00, evening = after 17:00. Tools use 24-hour HH:mm; talk to patients in 12-hour time.

RULES
1. Before booking, cancelling, rescheduling or showing appointments, identify the patient by phone number. Ask for it if you don't have it. If the number is not registered, ask name, age and gender and register them.
2. If any information is missing (date, doctor, time, phone, reason, which appointment) ASK - never guess. Ask one short question at a time.
3. Before booking, cancelling or rescheduling, summarise the action (doctor, date, time, fee, room) and ask "Shall I confirm? (yes/no)". Call the tool only after the patient says yes.
4. Use tools for all facts. Never invent doctors, slots, fees, rooms or ids.
5. If a tool returns an error, explain it kindly and offer an alternative (e.g. other free slots). The clinic rules (no double booking, no past slots, cancel/reschedule at least 2 hours before) cannot be bypassed.
6. "it" / "that appointment" means the one just discussed. If the patient has several appointments, ask which one.
7. After booking, tell the doctor, date, time, fee, room number and appointment id.
8. Keep replies short, plain text.`;
}

async function ask(userText) {
  messages.push({ role: 'user', content: userText });
  const startLength = messages.length - 1;

  try {
    for (let round = 0; round < 6; round++) {
      const res = await groq.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages: [{ role: 'system', content: systemPrompt() }, ...messages],
        tools: toolDefinitions(isAdmin),
        tool_choice: 'auto',
      });
      const msg = res.choices[0].message;
      const calls = msg.tool_calls || [];
      messages.push({ role: 'assistant', content: msg.content || '', ...(calls.length && { tool_calls: calls }) });

      if (!calls.length) return msg.content || 'Sorry, could you say that again?';

      for (const call of calls) {
        let result;
        try {
          result = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}'), isAdmin);
        } catch {
          result = { error: 'Invalid tool arguments.' };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    return 'Sorry, that got complicated. Could you ask in a simpler way?';
  } catch (err) {
    messages.length = startLength; // drop the failed turn
    if (err.status === 404) return `Model "${MODEL}" is not available on this Groq account. Change GROQ_MODEL in .env.`;
    if (err.status === 401) return 'The Groq API key is invalid. Check GROQ_API_KEY in .env.';
    if (err.status === 429) return 'Too many requests right now. Please wait a few seconds and try again.';
    console.error(err.message);
    return 'Sorry, something went wrong. Please try again.';
  }
}

/* ------------------------------------------------------------------ CLI */

try {
  await connect();
} catch {
  console.error('Could not connect to MongoDB. Is it running? Check MONGODB_URI in .env.');
  process.exit(1);
}

console.log(`\n=== ${AGENT_NAME} ===  (type /admin <PIN> for admin mode, /exit to quit)\n`);
console.log(`${AGENT_NAME}: ${GREETING}\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'You: ' });
rl.prompt();
let queue = Promise.resolve();

rl.on('line', (line) => {
  queue = queue.then(async () => {
    const text = line.trim();
if (['/exit', 'exit', 'quit', '/quit'].includes(text.toLowerCase())) return rl.close();    if (text.startsWith('/admin')) {
      const ok = process.env.ADMIN_PIN && text.slice(6).trim() === process.env.ADMIN_PIN;
      isAdmin = ok;
      console.log(`\n${AGENT_NAME}: ${ok ? 'Admin mode ON.' : 'Wrong admin PIN.'}\n`);
    } else if (text) {
      console.log(`\n${AGENT_NAME}: ${await ask(text)}\n`);
    }
    rl.prompt();
  });
});

rl.on('close', () => queue.then(async () => { await close(); process.exit(0); }));
