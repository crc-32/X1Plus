/* X1Plus installer back-end
 *
 * Copyright (c) 2023 - 2024 Joshua Wise, and the X1Plus authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { findPrinters, Printer } from 'x1p-js';
import { InstallerProps, InstallerParams } from './renderer.d';
import { Readable } from 'stream';
import ota_data from './ota_data';
import path from 'path';
import AdmZip from 'adm-zip';
import stream from 'stream';
import tar from 'tar';
import crypto from 'crypto';
import Store from 'electron-store';

// This allows TypeScript to pick up the magic constants that's auto-generated by Forge's Webpack
// plugin that tells the Electron app where to look for the Webpack-bundled app code (depending on
// whether you're running in development or production).
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const FLAG2_IS_FIRMWARE_R = 1;
const FLAG2_APPLICATION_IS_SIGNED = 2;
const FLAG2_APPLICATION_IS_UNSIGNED = 4;
const FLAG2_PRINTER_IS_UNLOCKED = 8;
const FLAG2_SSHD_IS_RUNNING = 16;

const LEGACY_EXPLOIT_INSTALL_ALLOWED = false;

const MQTT_TIMEOUT = 15000;
const CONNECT_TIMEOUT = 3000;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

Store.initRenderer();
const store = new Store();

const resourcePath = !process.env.NODE_ENV || process.env.NODE_ENV === "production" ? process.resourcesPath : path.join(__dirname, '..', '..', 'src');
console.log(resourcePath);

const cfwPath = path.join(resourcePath, "cfw.x1p");
const setupPath = path.join(resourcePath, "setup.tgz");

var zip = new AdmZip(cfwPath);
var zipentry = zip.getEntry("info.json");
const cfwInfo = JSON.parse(zip.readAsText("info.json"));

const createWindow = (): void => {
  const win = new BrowserWindow({
    height: 600,
    width: 800,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
    icon: path.join(resourcePath, 'icon.png'),
  });

  win.removeMenu();
  win.setMaximizable(false);
  win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
};

let props: InstallerProps = {
  printersAvailable: [],
  isConnecting: false,
  isConnected: false,
  connectedPrinter: null,
  lastConnectionError: "",
  bundledX1pVersion: cfwInfo.cfwVersion,
  printerOtaVersion: null,
  printerOtaVersionMessage: null,
  printerOtaVersionCompatible: null,
  printerIsFirmwareR: false,
  readyToInstall: false,
  
  isInstalling: false,
  currentStep: 0,
  installSteps: [],
  intraStatus: null,
  installFailureMessage: null,

  installFinished: false,
};
let updateProps = () => {};

let params: InstallerParams = {
  wifiCompatibilityMode: false,
};

let printer: Printer;

findPrinters((ip: string, serial: string) => {
  if (!props.printersAvailable.some((p) => p.ip == ip)) {
    console.log(`index.ts: discovered printer ${ip} ${serial}`);
    props.printersAvailable.push({ip: ip, serial: serial});
  }
  updateProps();
});

function versionIsFirmwareR(version: string) {
  return version >= '01.06.06.54' && version <= '01.06.99.99';
}

async function checkPrinterOtaVersion() {
  const printStatus: any = await printer.waitPrintStatus();
  await printer.mqttSend({info: { sequence_id: '0', command: 'get_version' }});
  props.printerOtaVersion = await printer.mqttRecvAsync((topic, msg: any) => {
    if ('info' in msg) {
      return msg['info']['module'][0]['sw_ver'];
    }
  });

  props.printerIsFirmwareR = false;
  props.printerOtaVersionCompatible = false;
  
  const firmwareRFlag = printStatus.flag2 || 0;

  if (props.printerOtaVersion == '99.00.00.00') {
    props.printerOtaVersionMessage = 'This printer is already running X1Plus.  To install a new version of X1Plus, copy the .x1p file to the SD card and restart the printer.';
    props.printerOtaVersionCompatible = false;
  } else if (firmwareRFlag & FLAG2_IS_FIRMWARE_R) {
    if (!(firmwareRFlag & FLAG2_PRINTER_IS_UNLOCKED)) {
      props.printerOtaVersionMessage = "This printer has the Official Rootable Firmware installed, but it has not been unlocked.  Follow the Third Party Firmware Plan instructions from Bambu Lab and try again.";
      props.printerOtaVersionCompatible = false;
    } else if (!(firmwareRFlag & FLAG2_SSHD_IS_RUNNING)) {
      props.printerOtaVersionMessage = "This printer has the Official Rootable Firmware installed, but the SSH server is not running.  Restart the printer and try again.";
      props.printerOtaVersionCompatible = false;
    } else {
      props.printerOtaVersionMessage = 'Supported for X1Plus installation via Official Rootable Firmware method.';
      props.printerIsFirmwareR = true;
      props.printerOtaVersionCompatible = true;
    }
  } else if (versionIsFirmwareR(props.printerOtaVersion)) {
    props.printerOtaVersionMessage = 'The Official Rootable Firmware appears to be installed, but the printer is not reporting its unlock status.  Restart the printer and try again.';
    props.printerOtaVersionCompatible = false;
  } else if (LEGACY_EXPLOIT_INSTALL_ALLOWED) {
    if (props.printerOtaVersion <= '01.07.00.00') {
      props.printerOtaVersionMessage = "Supported for X1Plus installation via legacy method.";
      props.printerOtaVersionCompatible = true;
    } else {
      props.printerOtaVersionMessage = `This printer's firmware is too new to install X1Plus.  Downgrade to 01.07.00.00 or below, or follow the Third Party Firmware Plan instructions from Bambu Lab.`;
      props.printerOtaVersionCompatible = false;
    }
  } else {
    if (props.printerCanHasFirmwareRUpgrade) {
      props.printerOtaVersionMessage = `This printer is eligible for the Official Rootable Firmware, but it is not currently installed.  Follow the Third Party Firmware Plan instructions from Bambu Lab and try again.`;
      props.printerOtaVersionCompatible = false;
    } else {
      props.printerOtaVersionMessage = `The Official Rootable Firmware is required to install X1Plus.  Follow the Third Party Firmware Plan instructions from Bambu Lab and try again.`;
      props.printerOtaVersionCompatible = false;
    }
  }
}

async function checkPrinterUpdateHistory() {
  await printer.mqttSend({upgrade: { sequence_id: '0', command: 'get_history' }});
  const firmwares: [any] = await printer.mqttRecvAsync((topic, msg: any) => {
    if (msg.upgrade && 'firmware_optional' in msg.upgrade) {
      return msg['upgrade']['firmware_optional'] || [];
    }
  });
  props.printerCanHasFirmwareRUpgrade = firmwares.some(fw => versionIsFirmwareR(fw.firmware.version) || fw.firmware.type == "firmware_r");
  if (props.printerCanHasFirmwareRUpgrade) {
    console.log(`index.ts: printer can has Firmware R in update history`);
  }
}

async function connectSsh(sshPassword: string) {
  if (!printer) {
    console.log("index.js: connectSsh but no printer?");
    return;
  }
  if (printer.sshClient) {
    console.log("index.js: connectSsh but already have a ssh client?");
    return;
  }
  if (!props.printerIsFirmwareR) {
    console.log("index.js: connectSsh but not Firmware R?");
    return;
  }
  
  printer.sshPort = 22;
  printer.sshUser = "root";
  printer.sshPass = sshPassword;
  props.lastConnectionError = "Connecting to SSH...";
  props.readyToInstall = false;
  updateProps();
  try {
    console.log("index.js: probing Firmware R printer sshd");
    await printer.connectSSH();
  } catch(e) {
    console.log(`index.js: Firmware R sshd probe had error ${e.toString()}`);
    if (e.message == 'All configured authentication methods failed') {
      if (sshPassword == "") {
        props.lastConnectionError = "Enter the SSH password.  (It's case sensitive, 8 characters.)";
      } else {
        props.lastConnectionError = `Incorrect SSH password.  (It's case sensitive, 8 characters.)`;
      }
    } else if (e.level == 'client-socket') {
      props.lastConnectionError = `SSH access is not enabled on this printer.  Enable it in the printer settings and try again.`;
    } else {
      props.lastConnectionError = `Unknown error connecting to SSH: ${e.toString()}`;
    }
    return;
  }

  /* ok, looks like we connected over ssh */
  props.lastConnectionError = "";
  let result = await printer.sshClient.execCommand('id');
  console.log(`index.js: connected to printer over ssh, I am ${result.stdout}`);
  props.readyToInstall = props.printerOtaVersionCompatible;
  store.set(`printers.${printer.serial}.sshPassword`, sshPassword);
  updateProps();
}

async function timeoutPromise<T>(ms: number, promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timeout"));
    }, ms);
    promise.then((value) => {
      clearTimeout(timeout);
      resolve(value);
    }, (reason) => {
      clearTimeout(timeout);
      reject(reason);
    });
  });
}

async function querySerial(ip: string, accessCode: string): Promise<string|null> {
  const printer = new Printer(ip);
  try {
    await timeoutPromise(CONNECT_TIMEOUT, printer.authenticate(accessCode));
    console.log(`index.js: querySerial(${ip}) connected`);
    const serial = await timeoutPromise<string>(MQTT_TIMEOUT, printer.mqttRecvAsync((topic, msg: any) => {
      if (topic.startsWith('device/')) {
        return topic.split('/')[2];
      }
    }));
    console.log(`index.js: querySerial(${ip}) got serial ${serial}`);
    if (!props.printersAvailable.some((p) => p.ip == ip)) {
      props.printersAvailable.push({ip: ip, serial: serial});
      updateProps();
    }
    return serial;
  } catch(e) {
    if (e.message == "timeout") {
      console.log(`index.js: querySerial connect timed out`);
      return null;
    } else {
      throw e;
    }
  } finally {
    printer.disconnect();
  }
}

async function connectPrinter(ip: string, accessCode: string, serial?: string, sshPassword?: string) {
  console.log(`index.js: connecting to printer ${ip} ${serial} ${accessCode} ${sshPassword}`);
  if (printer) {
    if (printer.host == ip && printer.serial == serial) {
      if (!printer.sshClient && props.printerIsFirmwareR && sshPassword) {
        console.log(`index.js: connected, but without a ssh connection; trying that`);
        props.isConnecting = true;
        await connectSsh(sshPassword);
        props.isConnecting = false;
        updateProps();
      }
      console.log(`index.js: already connected, bailing out`);
      return;
    }
    printer.disconnect();
    printer = null;
  }

  props.isInstalling = false;
  props.isConnecting = false;
  props.lastConnectionError = "";
  props.isConnected = false;
  props.readyToInstall = false;

  if (!ip || !accessCode) {
    updateProps();
    return;
  }

  if (!serial) {
    console.log(`index.js: no serial, trying to find it`);
    serial = await querySerial(ip, accessCode);
  }

  printer = new Printer(ip);
  props.isConnecting = true;
  props.lastConnectionError = "";
  updateProps();
  try {
    await printer.authenticate(accessCode);
    const printStatus: any = await printer.waitPrintStatus();
    const hasSdCard = printStatus['sdcard'] === true;
    await checkPrinterUpdateHistory();
    await checkPrinterOtaVersion();
    props.readyToInstall = props.printerOtaVersionCompatible && !props.printerIsFirmwareR;
    if (!hasSdCard) {
      props.printerOtaVersionMessage = "This printer does not have a SD card installed.  Insert a formatted SD card and try again.";
      props.printerOtaVersionCompatible = false;
      props.readyToInstall = false;
    }
    if (printStatus['upgrade_state']['force_upgrade'] || printStatus['upgrade_state']['consistency_request']) {
      props.printerOtaVersionMessage = "This printer's internal firmware is in an inconsistent state.  Repair the onboard firmware and try again.";
      props.printerOtaVersionCompatible = false;
      props.readyToInstall = false;
    }
    
    props.currentStep = 0
    props.installSteps = [];
    props.isConnected = true;
    
    store.set(`printers.${serial}.accessCode`, accessCode);
    
    if (props.printerIsFirmwareR) {
      await connectSsh(sshPassword || "");
    }
    
    props.isConnecting = false;

    updateProps();
  } catch (e) {
    console.log(e)
    printer.disconnect();
    printer = undefined;
    if (e.toString() == 'Error: Connection refused: Not authorized') {
      props.lastConnectionError = "Incorrect access code";
    } else {
      props.lastConnectionError = e.toString();
    }
    props.isConnecting = false;
    props.isConnected = false;
    store.delete(`printers.${serial}.accessCode`);
    updateProps();
  }
}

type InstallStep = {
  label: string;
  fn: () => Promise<void>;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}

const installStepsCommon: InstallStep[] = [
  {
    label: "Running on-printer installation",
    fn: async () => {
      props.intraStatus = "Use the installer on the printer's LCD to complete installation.";
      updateProps();
      await printer.mqttRecvAsync((topic, msg: any) => {
        if ('upgrade' in msg && msg['upgrade']['command'] == 'x1plus') {
          console.log(JSON.stringify(msg['upgrade']));
          if (msg['upgrade']['progress_complete']) {
            return true;
          }
          if (msg['upgrade']['progress']) {
            props.intraStatus = msg['upgrade']['progress'];
            updateProps();
          }
          if (msg['upgrade']['progress_failure']) {
            props.installFailureMessage = msg['upgrade']['progress_failure'];
            updateProps();
            throw(msg['upgrade']['progress_failure']);
          }
        }
      });
    },
  },
];

const legacyInstallSteps: InstallStep[] = [
  {
    label: "This installer does not support the legacy installation method.",
    fn: async () => {
      throw "How did you get here, anyway?";
    }
  }
];

const firmwareRInstallSteps: InstallStep[] = [
  {
    label: "Copying X1Plus setup files",
    fn: async () => {
      // probably should add installer gui button option to allow toggling this - "printer wifi power [ high | low ]"
      if (!params.wifiCompatibilityMode) {
        console.log(`install: disabling wlan0 powersaving mode`);
        props.intraStatus = "Disabling wlan0 powersaving mode...";
        let result = await printer.sshClient.execCommand("while true ; do iwconfig wlan0 power off > /dev/null 2>&1 ; sleep 4 ; done &");
        if (result.code != 0) {
          throw `failed to disable wlan powersaving (${result.stderr})`;
        }
      }

      console.log("install: cleaning up old x1ps...")
      props.intraStatus = "Cleaning up...";
      updateProps();
      const fileList = await printer.ftpClient.list();
      for (const file of fileList.values()) {
        if (file.name.endsWith(".x1p")) {
          console.log(`install: found old x1p ${file.name} (obliterating it)`);
          await printer.ftpClient.remove(file.name);
        }
      }
      try {
        await printer.ftpClient.remove("/x1plus/first_stage_status");
      } catch (e) {
      }
      
      console.log(`install: uploading ${cfwInfo.cfwVersion}.x1p...`);
      props.intraStatus = "Uploading custom firmware bundle...";
      updateProps();
      await printer.sshClient.putFile(cfwPath, `/sdcard/${cfwInfo.cfwVersion}.x1p`);
      console.log(`install: uploaded x1p`);

      console.log(`install: uploading setup.tgz...`);
      props.intraStatus = "Uploading installer...";
	  updateProps();
      await printer.sshClient.putFile(setupPath, `/sdcard/setup.tgz`);
      console.log(`install: uploaded tgz`);
    }
  },
  {
    label: "Unpacking installer",
    fn: async () => {
      let result = await printer.sshClient.execCommand("mount -o remount,exec /userdata");
      if (result.code != 0) {
        throw `failed to remount /userdata exec (${result.stderr})`;
      }
      
      result = await printer.sshClient.execCommand("cd /userdata;gzip -d -c /sdcard/setup.tgz | tar xv");
      if (result.code != 0) {
        throw `failed to unpack /sdcard/setup.tgz (${result.stderr})`;
      }

      try {
        await printer.ftpClient.remove("/setup.tgz");
      } catch (e) {
      }
    },
  },
  {
    label: "Starting on-printer installer",
    fn: async () => {
      let result = await printer.sshClient.execCommand("/userdata/x1plus/launch.sh");
      if (result.code != 0) {
        throw `failed to run launcher (${result.stderr})`;
      }

      var key = "";
      while (1) {
        try {
          var wr = new stream.Writable();
          key = "";
          wr._write = function (chunk, encoding, done) {
            key += chunk.toString();
            done();
          };
          await printer.ftpClient.downloadTo(wr, "/x1plus/first_stage_status");
          break;
        } catch (e) {
          await sleep(1000);
        }
      }
      await printer.ftpClient.remove("/x1plus/first_stage_status");
    },
  },
  ...installStepsCommon
];


async function startInstall() {
  const steps = props.printerIsFirmwareR ? firmwareRInstallSteps : legacyInstallSteps;

  props.isInstalling = true;
  props.currentStep = 0;
  props.installSteps = steps.map((step) => step.label);
  updateProps();
  for (const step of steps.values()) {
    try {
      await step.fn();
    } catch (e) {
      console.log(`install: exception in step "${step.label}": ${e.toString()}`);
      props.installFailureMessage = e.toString();
      updateProps();
      return;
    }
    props.currentStep += 1;
    props.intraStatus = null;
    updateProps();
  }

  props.installFinished = true;
  updateProps();
}

async function startRecovery() {
  props.isInstalling = true;
  props.currentStep = 0;
  props.installSteps = ["Starting recovery..."];
  props.installFailureMessage = "This version of the installer does not support recovery mode.";
  updateProps();
}

app.on('ready', () => {
  ipcMain.on('log', async (ev, ...args) => { console.log(...args); });
  ipcMain.on('subscribeInstallerProps', async(ev) => { updateProps = () => ev.reply('newInstallerProps', props); updateProps(); });
  ipcMain.on('connectPrinter', async (ev, ip: string, accessCode: string, serial?: string, sshPassword?: string) => await connectPrinter(ip, accessCode, serial, sshPassword));
  ipcMain.on('startInstall', async (ev) => await startInstall());
  ipcMain.on('startRecovery', async (ev) => await startRecovery());
  ipcMain.on('setParams', async (ev, _params: InstallerParams) => { params = {...params, ..._params}; });
  ipcMain.on('getStore', async (ev, val) => ev.returnValue = store.get(val));
  ipcMain.handle('querySerial', async (ev, ip: string, accessCode: string) => querySerial(ip, accessCode))
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
