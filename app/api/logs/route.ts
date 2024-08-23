import path from 'path';
import fs from 'fs/promises';
import { NextResponse } from 'next/server';
import archiver from 'archiver';
import { Readable } from 'stream';

export async function GET(req: Request) {
  const logDir = process.env.LOGS_DIR;

  console.log(`logsDir: ${logDir}`);

  if (!logDir) {
    return new NextResponse('LOGS_DIR environment variable is not set', {
      status: 500,
    });
  }

  try {
    const logFiles = await fs.readdir(logDir);
    const zipFileName = 'logs.zip';

    // Create an in-memory stream for the ZIP archive
    const archive = archiver('zip', { zlib: { level: 9 } });
    const archiveStream = new Readable().wrap(archive);

    logFiles.forEach((file) => {
      const filePath = path.join(logDir, file);
      archive.file(filePath, { name: file });
    });

    // Finalize the archive (this will flush the stream)
    await archive.finalize();

    return new NextResponse(archiveStream as any, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFileName}"`,
      },
    });
  } catch (error) {
    console.error('Error generating log ZIP:', error);
    return new NextResponse('Error generating log ZIP', { status: 500 });
  }
}
