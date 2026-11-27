import { fileURLToPath } from 'node:url';

// The engine finds the app root from the working directory: every test runs inside the fixture app
process.chdir(fileURLToPath(new URL('./fixtures/app', import.meta.url)));
