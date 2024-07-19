"use server"

import {SCRIPTS_PATH} from '@/config/env';
import fs from 'fs/promises';

export async function newFile(name: string, instructions: string, fileName: string) {
    try {
        const files = await fs.readdir(SCRIPTS_PATH());
        const gptFiles = files.filter(file => file.endsWith('.gpt'));

        if (gptFiles.includes(fileName)) throw new Error('file already exists');
        if (!fileName.endsWith('.gpt')) {
            throw new Error('file cannot be empty and must end with .gpt');
        }

        await fs.writeFile(`${SCRIPTS_PATH()}/${fileName}`, `---\nName: ${name}\nChat: true\n\n${instructions}\n\n`);
        return fileName.replace('.gpt', '')
    } catch (e) {
        throw e;
    }
}
