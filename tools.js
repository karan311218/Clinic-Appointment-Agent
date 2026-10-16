import { db } from './db.js';

// Every tool reads/writes MongoDB and returns a plain object ({ error } on failure).
// Business rules (no double booking, no past slots, 2-hour cancel rule) are enforced HERE in code.

const col = (name) => db().collection(name);
const NO_ID = { projection: { _id: 0 } };
const slotTime = (s) => new Date(`${s.slot_date}T${s.start_time}:00`);
const hoursUntil = (s) => (slotTime(s) - new Date()) / 36e5;
const safeRegex = (text) => new RegExp(String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const cleanPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

async function nextId(collection, field) {
  const last = await col(collection).find({}, { projection: { [field]: 1 } }).sort({ [field]: -1 }).limit(1).toArray();
  return (last[0]?.[field] || 0) + 1;
}

async function getPatient(phone) {
  const p = cleanPhone(phone);
  if (p.length !== 10) return { error: 'A valid 10-digit phone number is needed. Ask the patient for it.' };
  const patient = await col('patients').findOne({ phone: p }, NO_ID);
  if (!patient) return { error: 'No patient found with this phone number. Ask for name, age and gender and register them.' };
  return { patient };
}

// Loads an appointment + its slot and applies the "2+ hours before" rule.
async function getChangeableAppointment(phone, appointment_id) {
  const { patient, error } = await getPatient(phone);
  if (error) return { error };
  const appt = await col('appointments').findOne({ appointment_id: Number(appointment_id), patient_id: patient.patient_id }, NO_ID);
  if (!appt) return { error: 'No appointment with that ID was found for this phone number.' };
  if (appt.status !== 'BOOKED') return { error: `This appointment is already ${appt.status}.` };
  const slot = await col('slots').findOne({ slot_id: appt.slot_id }, NO_ID);
  if (hoursUntil(slot) < 2) return { error: 'Appointments can only be cancelled or rescheduled at least 2 hours before the slot.' };
  return { patient, appt, slot };
}

/* ----------------------------------------------------------------- tools */

async function list_doctors({ specialization } = {}) {
  const filter = specialization ? { specialization: safeRegex(specialization) } : {};
  const doctors = await col('doctors').find(filter, NO_ID).toArray();
  if (!doctors.length) return { error: 'No doctors found for that specialization.', available: await col('doctors').distinct('specialization') };
  return { doctors };
}

async function find_free_slots({ doctor_name, specialization, date, after_time, before_time } = {}) {
  if (!date) return { error: 'Date is required. Ask the patient which day they want.' };
  if (!doctor_name && !specialization) return { error: 'Doctor name or specialization is required.' };

  const filter = doctor_name
    ? { name: safeRegex(String(doctor_name).replace(/^dr\.?\s*/i, '')) }
    : { specialization: safeRegex(specialization) };
  const doctors = await col('doctors').find(filter, NO_ID).toArray();
  if (!doctors.length) return { error: 'No matching doctor found.' };

  const query = { doctor_id: { $in: doctors.map((d) => d.doctor_id) }, slot_date: date, is_booked: false };
  if (after_time || before_time) {
    query.start_time = {};
    if (after_time) query.start_time.$gte = after_time; // "HH:mm" strings compare correctly
    if (before_time) query.start_time.$lt = before_time;
  }
  const slots = (await col('slots').find(query, NO_ID).sort({ doctor_id: 1, start_time: 1 }).toArray()).filter((s) => slotTime(s) > new Date());
  if (!slots.length) return { error: 'No free slots for that doctor/date/time. Suggest another time or day.' };

  return {
    date,
    slots: slots.slice(0, 15).map((s) => {
      const d = doctors.find((x) => x.doctor_id === s.doctor_id);
      return { slot_id: s.slot_id, doctor: d.name, specialization: d.specialization, time: s.start_time, fee: d.consultation_fee, room: d.room_no };
    }),
  };
}

async function register_patient({ name, phone, age, gender } = {}) {
  const p = cleanPhone(phone);
  if (p.length !== 10) return { error: 'A valid 10-digit phone number is needed.' };
  if (await col('patients').findOne({ phone: p })) return { error: 'This phone number is already registered.' };
  if (!name || !age || !gender) return { error: 'Name, age and gender are all needed. Ask the patient.' };
  const patient = { patient_id: await nextId('patients', 'patient_id'), name, phone: p, age: Number(age), gender };
  await col('patients').insertOne({ ...patient });
  return { registered: true, patient };
}

async function book_appointment({ phone, slot_id, reason } = {}) {
  const { patient, error } = await getPatient(phone);
  if (error) return { error };
  if (!reason) return { error: 'Ask the patient for a short reason for the visit.' };

  const slot = await col('slots').findOne({ slot_id: Number(slot_id) }, NO_ID);
  if (!slot) return { error: 'That slot does not exist.' };
  if (slotTime(slot) <= new Date()) return { error: 'That slot is in the past and cannot be booked.' };

  // Atomic: only succeeds if the slot is still free, so a slot can never be booked twice.
  const claimed = await col('slots').findOneAndUpdate({ slot_id: slot.slot_id, is_booked: false }, { $set: { is_booked: true } });
  if (!claimed) return { error: 'Sorry, that slot is already booked. Offer another slot.' };

  const appointment = { appointment_id: await nextId('appointments', 'appointment_id'), patient_id: patient.patient_id, slot_id: slot.slot_id, reason, status: 'BOOKED', created_at: new Date() };
  try {
    await col('appointments').insertOne({ ...appointment });
  } catch (err) {
    await col('slots').updateOne({ slot_id: slot.slot_id }, { $set: { is_booked: false } }); // undo
    throw err;
  }
  const doctor = await col('doctors').findOne({ doctor_id: slot.doctor_id }, NO_ID);
  return { booked: true, appointment_id: appointment.appointment_id, patient: patient.name, doctor: doctor.name, date: slot.slot_date, time: slot.start_time, fee: doctor.consultation_fee, room: doctor.room_no };
}

async function cancel_appointment({ phone, appointment_id } = {}) {
  const { appt, error } = await getChangeableAppointment(phone, appointment_id);
  if (error) return { error };
  await col('appointments').updateOne({ appointment_id: appt.appointment_id }, { $set: { status: 'CANCELLED' } });
  await col('slots').updateOne({ slot_id: appt.slot_id }, { $set: { is_booked: false } });
  return { cancelled: true, appointment_id: appt.appointment_id };
}

async function reschedule_appointment({ phone, appointment_id, new_slot_id } = {}) {
  const { appt, error } = await getChangeableAppointment(phone, appointment_id);
  if (error) return { error };

  const newSlot = await col('slots').findOne({ slot_id: Number(new_slot_id) }, NO_ID);
  if (!newSlot) return { error: 'The new slot does not exist.' };
  if (slotTime(newSlot) <= new Date()) return { error: 'The new slot is in the past.' };

  const claimed = await col('slots').findOneAndUpdate({ slot_id: newSlot.slot_id, is_booked: false }, { $set: { is_booked: true } });
  if (!claimed) return { error: 'Sorry, that slot is already booked. Offer another slot.' };

  await col('appointments').updateOne({ appointment_id: appt.appointment_id }, { $set: { slot_id: newSlot.slot_id } });
  await col('slots').updateOne({ slot_id: appt.slot_id }, { $set: { is_booked: false } });
  const doctor = await col('doctors').findOne({ doctor_id: newSlot.doctor_id }, NO_ID);
  return { rescheduled: true, appointment_id: appt.appointment_id, doctor: doctor.name, date: newSlot.slot_date, time: newSlot.start_time, room: doctor.room_no, fee: doctor.consultation_fee };
}

async function get_patient_appointments({ phone } = {}) {
  const { patient, error } = await getPatient(phone);
  if (error) return { error };
  const appts = await col('appointments').find({ patient_id: patient.patient_id }, NO_ID).toArray();
  if (!appts.length) return { patient: patient.name, appointments: [], message: 'No appointments yet.' };

  const rows = [];
  for (const a of appts) {
    const slot = await col('slots').findOne({ slot_id: a.slot_id }, NO_ID);
    const doctor = await col('doctors').findOne({ doctor_id: slot.doctor_id }, NO_ID);
    const past = slotTime(slot) <= new Date();
    rows.push({ appointment_id: a.appointment_id, status: a.status === 'BOOKED' && past ? 'COMPLETED' : a.status, when: past ? 'past' : 'upcoming', doctor: doctor.name, date: slot.slot_date, time: slot.start_time, room: doctor.room_no, reason: a.reason });
  }
  return { patient: patient.name, appointments: rows };
}

// ADMIN ONLY (only given to the AI after a correct /admin PIN)
async function get_daily_schedule({ date } = {}) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = date || today;
  const slots = await col('slots').find({ slot_date: day, is_booked: true }, NO_ID).sort({ start_time: 1 }).toArray();
  const rows = [];
  for (const s of slots) {
    const a = await col('appointments').findOne({ slot_id: s.slot_id, status: 'BOOKED' }, NO_ID);
    if (!a) continue;
    const doctor = await col('doctors').findOne({ doctor_id: s.doctor_id }, NO_ID);
    const patient = await col('patients').findOne({ patient_id: a.patient_id }, NO_ID);
    rows.push({ doctor: doctor.name, room: doctor.room_no, time: s.start_time, patient: patient.name, phone: patient.phone, reason: a.reason });
  }
  rows.sort((x, y) => x.doctor.localeCompare(y.doctor) || x.time.localeCompare(y.time));
  return { date: day, total: rows.length, appointments: rows };
}

/* ------------------------------------------------------ tool definitions */

const def = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const phone = { type: 'string', description: "Patient's 10-digit phone number" };

const PATIENT_TOOLS = [
  def('list_doctors', 'List doctors with fee and room number. Optional filter by specialization.', { specialization: { type: 'string' } }),
  def('find_free_slots', 'Find free slots for a doctor (name) or a specialization on one date.', {
    date: { type: 'string', description: 'YYYY-MM-DD' },
    doctor_name: { type: 'string', description: 'e.g. Mehta' },
    specialization: { type: 'string' },
    after_time: { type: 'string', description: 'HH:mm 24-hour, slots starting at or after' },
    before_time: { type: 'string', description: 'HH:mm 24-hour, slots starting before' },
  }, ['date']),
  def('register_patient', 'Create a new patient (only if the phone number is new).', {
    name: { type: 'string' }, phone, age: { type: 'integer' }, gender: { type: 'string' },
  }, ['name', 'phone', 'age', 'gender']),
  def('book_appointment', 'Book a free slot for a patient. Call ONLY after the patient confirmed.', {
    phone, slot_id: { type: 'integer' }, reason: { type: 'string' },
  }, ['phone', 'slot_id', 'reason']),
  def('cancel_appointment', 'Cancel an appointment. Call ONLY after the patient confirmed.', {
    phone, appointment_id: { type: 'integer' },
  }, ['phone', 'appointment_id']),
  def('reschedule_appointment', 'Move an appointment to another free slot. Call ONLY after the patient confirmed.', {
    phone, appointment_id: { type: 'integer' }, new_slot_id: { type: 'integer' },
  }, ['phone', 'appointment_id', 'new_slot_id']),
  def('get_patient_appointments', 'Upcoming and past appointments of a patient.', { phone }, ['phone']),
];
const ADMIN_TOOLS = [
  def('get_daily_schedule', 'ADMIN: all doctors\' appointments for a date (default today).', { date: { type: 'string', description: 'YYYY-MM-DD' } }),
];

const HANDLERS = { list_doctors, find_free_slots, register_patient, book_appointment, cancel_appointment, reschedule_appointment, get_patient_appointments, get_daily_schedule };

export const toolDefinitions = (isAdmin) => (isAdmin ? [...PATIENT_TOOLS, ...ADMIN_TOOLS] : PATIENT_TOOLS);

export async function runTool(name, args, isAdmin) {
  if (!HANDLERS[name]) return { error: `Unknown tool ${name}.` };
  if (name === 'get_daily_schedule' && !isAdmin) return { error: 'Admin access required.' };
  try {
    return await HANDLERS[name](args || {});
  } catch (err) {
    console.error(`[${name}]`, err.message);
    return { error: 'A database problem occurred. Apologise and ask the user to try again.' };
  }
}
