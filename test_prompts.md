# Test prompts and MediSlot replies

Run `npm run seed`, then `npm start`. Type each prompt (answer the agent's follow-up questions) and paste the real replies below.
For prompt 5 first type `/admin <PIN>`.

## 1. I have a bad toothache, which doctor should I see tomorrow?
MediSlot: (paste reply)

## 2. Book me with Dr. Mehta on Friday after 4 pm. My number is 9876543210.
MediSlot: (paste reply, including the confirmation step)

## 3. Move my appointment to Saturday morning.
MediSlot: (paste reply)

## 4. Cancel my appointment.
MediSlot: (paste reply)

## 5. (Admin) Show me today's schedule for all doctors.
MediSlot: (paste reply)

## Business rule violation blocked
Example: after booking a slot, try to book the same slot again with another patient (e.g. 9123456780).
MediSlot: (paste reply: "slot is already booked")
