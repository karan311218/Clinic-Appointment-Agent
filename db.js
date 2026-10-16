import 'dotenv/config';
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
let database;

export async function connect() {
  await client.connect();
  database = client.db(process.env.MONGODB_DB || 'medislot');
  return database;
}
export const db = () => database;
export const close = () => client.close();
