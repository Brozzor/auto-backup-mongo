const cron = require('node-cron');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
require('dotenv').config();

const performBackup = async () => {
  let mongodbUri = process.env.MONGODB_HOST
  if (process.env.MONGODB_USERNAME && process.env.MONGODB_PASSWORD) mongodbUri = `${process.env.MONGODB_USERNAME}:${process.env.MONGODB_PASSWORD}@${process.env.MONGODB_HOST}`
  const client = await MongoClient.connect('mongodb://' +mongodbUri );
  let dbs = await client.db().admin().listDatabases();
  dbs = dbs.databases.map(db => db.name);

  for (const db of dbs) {
    if (db === 'admin' || db === 'config' || db === 'local') continue;
    if (process.env.MONGODB_USERNAME, process.env.MONGODB_PASSWORD) {
      const user = await client.db(db).command({ usersInfo: process.env.MONGODB_USERNAME, showCredentials: true });
      if (user.users.length === 0) {
        await client.db(db).command({
          createUser: process.env.MONGODB_USERNAME,
          pwd: process.env.MONGODB_PASSWORD,
          roles: [
            { role: 'read', db: db },
          ],
        });
      }
    }
    if (!fs.existsSync('./backups/' + db)) fs.mkdirSync('./backups/' + db);
    await new Promise((resolve, reject) => {
      const childParams = [
        `--host=${process.env.MONGODB_HOST}`,
        '--db=' + db,
        '--out=./backups/' + db + '/temp/',
      ]
      if (process.env.MONGODB_USERNAME) childParams.push('--username=' + process.env.MONGODB_USERNAME);
      if (process.env.MONGODB_PASSWORD) childParams.push('--password=' + process.env.MONGODB_PASSWORD);

      const child = require('child_process').spawn('mongodump', childParams);

      child.on('exit', resolve);
      child.on('error', (err) => {
        console.log(err);
        reject(err);
      });
    });
    const date = new Date();
    const dateString = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}`;
    const output = fs.createWriteStream(`./backups/${db}/${dateString}.zip`);
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });
    archive.pipe(output);
    archive.directory(`./backups/${db}/temp/${db}/`, false);
    await archive.finalize();
    if (fs.existsSync(`./backups/${db}/temp/`)) await fsPromises.rmdir(`./backups/${db}/temp/`, { recursive: true });
    const files = fs.readdirSync(`./backups/${db}/`);
    if (files.length > process.env.BACKUP_LIMIT) {
      const filesToDelete = files.slice(0, files.length - process.env.BACKUP_LIMIT);
      for (const file of filesToDelete) {
        await fsPromises.unlink(`./backups/${db}/${file}`);
      }
    }
  }

  client.close();
  return 
};

function getFolderSize(folderPath) {
  let totalSize = 0;

  function calculateSize(dirPath) {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);

      if (stats.isDirectory()) {
        calculateSize(filePath);
      } else {
        totalSize += stats.size;
      }
    }
  }

  calculateSize(folderPath);

  return totalSize;
}

cron.schedule(process.env.BACKUP_CRON, async () => {
  const startBackup = new Date();
  if (!fs.existsSync('./backups')) {
    fs.mkdirSync('./backups');
  }
  try {
    await performBackup();
    console.log('Toutes les sauvegardes sont terminées.');
  } catch (error) {
    console.log(error)
    console.error(`Erreur lors de la sauvegarde : ${error}`);
  }
  const endBackup = new Date();
  console.log(`Backup took ${(endBackup - startBackup) / 1000} seconds`);
  const fileSizeInBytes = getFolderSize('./backups');
  const fileSizeInMegabytes = fileSizeInBytes / 1000000.0;
  console.log(`size of backup folder : ${fileSizeInMegabytes} Mb`);

});