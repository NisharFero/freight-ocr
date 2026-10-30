// Prints an AUTH_USERS entry: npm run hash-password -- <user> <password>
import { createHash } from 'node:crypto';
const [user, pass] = process.argv.slice(2);
if (!user || !pass) { console.error('usage: npm run hash-password -- <user> <password>'); process.exit(1); }
if (pass.length < 12) { console.error('use a password of at least 12 characters'); process.exit(1); }
console.log(`${user}:${createHash('sha256').update(pass).digest('hex')}`);
