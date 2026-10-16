// Creates the collections, indexes and sample data. Run: npm run seed
import { connect, close } from './db.js';

const doctors = [
  { name: 'Dr. Anil Mehta',   specialization: 'General Physician', consultation_fee: 500, room_no: '101', start: '10:00', end: '18:00' },
  { name: 'Dr. Sneha Kapoor', specialization: 'Dermatology',       consultation_fee: 700, room_no: '102', start: '09:00', end: '15:00' },
  { name: 'Dr. Rohit Verma',  specialization: 'Dentistry',         consultation_fee: 600, room_no: '103', start: '10:00', end: '17:00' },
  { name: 'Dr. Priya Nair',   specialization: 'Pediatrics',        consultation_fee: 600, room_no: '104', start: '11:00', end: '17:00' },
  { name: 'Dr. Arjun Singh',  specialization: 'Orthopedics',       consultation_fee: 800, room_no: '105', start: '09:00', end: '14:00' },
  { name: 'Dr. Kavita Rao',   specialization: 'ENT',               consultation_fee: 650, room_no: '106', start: '10:00', end: '16:00' },
];

const patients = [
  ['Rahul Sharma', '9876543210', 32, 'Male'], ['Anita Desai', '9123456780', 45, 'Female'],
  ['Vikram Patel', '9988776655', 28, 'Male'], ['Sunita Reddy', '9871234560', 52, 'Female'],
  ['Aarav Gupta', '9765432108', 7, 'Male'],   ['Meera Iyer', '9812345670', 36, 'Female'],
  ['Karan Malhotra', '9898989898', 41, 'Male'], ['Pooja Bansal', '9701234567', 24, 'Female'],
  ['Suresh Kumar', '9654321098', 63, 'Male'], ['Fatima Sheikh', '9555123456', 30, 'Female'],
].map(([name, phone, age, gender], i) => ({ patient_id: i + 1, name, phone, age, gender }));

const pad = (n) => String(n).padStart(2, '0');
const toTime = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const toMins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

const db = await connect();
for (const c of ['doctors', 'slots', 'patients', 'appointments']) await db.collection(c).drop().catch(() => {});

// doctors
const doctorDocs = doctors.map(({ start, end, ...d }, i) => ({ doctor_id: i + 1, ...d, _hours: [start, end] }));
await db.collection('doctors').insertMany(doctorDocs.map(({ _hours, ...d }) => d));

// patients
await db.collection('patients').insertMany(patients);
await db.collection('patients').createIndex({ phone: 1 }, { unique: true });

// slots: 30-minute slots, today + next 7 days, Monday-Saturday, skipping times already passed
const slots = [];
let slot_id = 1;
for (let d = 0; d < 8; d++) {
  const day = new Date();
  day.setDate(day.getDate() + d);
  if (day.getDay() === 0) continue; // Sunday closed
  const slot_date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  for (const doc of doctorDocs) {
    for (let m = toMins(doc._hours[0]); m + 30 <= toMins(doc._hours[1]); m += 30) {
      if (new Date(`${slot_date}T${toTime(m)}:00`) <= new Date()) continue;
      slots.push({ slot_id: slot_id++, doctor_id: doc.doctor_id, slot_date, start_time: toTime(m), end_time: toTime(m + 30), is_booked: false });
    }
  }
}
await db.collection('slots').insertMany(slots);
await db.collection('slots').createIndex({ doctor_id: 1, slot_date: 1, start_time: 1 }, { unique: true });
await db.collection('appointments').createIndex({ appointment_id: 1 }, { unique: true });

console.log(`Seeded ${doctors.length} doctors, ${patients.length} patients, ${slots.length} slots.`);
console.log('Test patient: Rahul Sharma, phone 9876543210');
await close();
