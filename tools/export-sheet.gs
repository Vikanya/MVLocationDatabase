/**
 * Exports every tab of the spreadsheet to a Drive folder "MV Locations Export":
 *   index.json                         list of tabs (name, gid, position)
 *   tabs/<gid>.json                    every non-empty cell: text, links, formula, note, image
 *   images/<gid>_r<row>_c<col>.<ext>   in-cell screenshots, original resolution
 *   errors.txt                         images that could not be saved (only if any)
 *   links.json                         smart chip / hyperlink URLs per cell (exportLinks)
 *
 * Paste into Extensions → Apps Script of the sheet, then run exportAll() once.
 * Tabs are exported first (fast), then images in ~5 minute chunks; the script
 * schedules itself to continue until done. Run resetExport() to start over.
 */
const EXPORT_FOLDER = 'MV Locations Export';
const CHUNK_MS = 5 * 60 * 1000;

function exportAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('An export run is already in progress.');
    return;
  }
  try {
    runChunk_(Date.now());
  } finally {
    lock.releaseLock();
  }
}

function resetExport() {
  clearTriggers_();
  PropertiesService.getScriptProperties().deleteAllProperties();
  console.log(`Progress cleared. Delete the "${EXPORT_FOLDER}" folder in Drive before running again.`);
}

/**
 * Smart chips (YouTube, Maps…) are invisible to SpreadsheetApp, so their URLs
 * come from the Sheets API instead. Requires the "Google Sheets API" advanced
 * service (Services → + → Google Sheets API). Writes links.json: { gid: [{ r, c, urls }] }.
 */
function exportLinks() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const res = Sheets.Spreadsheets.get(ss.getId(), {
    includeGridData: true,
    fields:
      'sheets(properties(sheetId,title),data(startRow,startColumn,' +
      'rowData(values(hyperlink,chipRuns,textFormatRuns(startIndex,format/link)))))',
  });

  const out = {};
  res.sheets.forEach((sheet) => {
    const cells = [];
    (sheet.data || []).forEach((grid) => {
      (grid.rowData || []).forEach((row, r) => {
        (row.values || []).forEach((v, c) => {
          const urls = [];
          const add = (url) => {
            if (url && !urls.includes(url)) urls.push(url);
          };
          add(v.hyperlink);
          (v.chipRuns || []).forEach((run) => add(run.chip && run.chip.richLinkProperties && run.chip.richLinkProperties.uri));
          (v.textFormatRuns || []).forEach((run) => add(run.format && run.format.link && run.format.link.uri));
          if (urls.length) cells.push({ r: (grid.startRow || 0) + r + 1, c: (grid.startColumn || 0) + c + 1, urls });
        });
      });
    });
    out[sheet.properties.sheetId] = cells;
  });

  const root = childFolder_(DriveApp.getRootFolder(), EXPORT_FOLDER);
  writeFile_(root, 'links.json', JSON.stringify(out));
  const count = Object.keys(out).reduce((n, gid) => n + out[gid].length, 0);
  console.log(`Saved links for ${count} cells.`);
}

function runChunk_(started) {
  const props = PropertiesService.getScriptProperties();
  const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  const root = childFolder_(DriveApp.getRootFolder(), EXPORT_FOLDER);

  if (props.getProperty('tabsDone') !== 'yes') {
    exportTabs_(root, sheets);
    props.setProperty('tabsDone', 'yes');
    console.log(`Exported ${sheets.length} tabs. Starting images.`);
  }

  const images = childFolder_(root, 'images');
  let s = Number(props.getProperty('sheet') || 0);
  let row = Number(props.getProperty('row') || 0);
  for (; s < sheets.length; s++, row = 0) {
    const sheet = sheets[s];
    const gid = sheet.getSheetId();
    const values = sheet.getDataRange().getValues();
    for (; row < values.length; row++) {
      if (Date.now() - started > CHUNK_MS) {
        props.setProperties({ sheet: String(s), row: String(row) });
        scheduleContinue_();
        console.log(`Paused at tab ${s + 1}/${sheets.length} "${sheet.getName()}", row ${row + 1}. Continuing in 1 minute.`);
        return;
      }
      values[row].forEach((value, c) => {
        if (isImage_(value)) saveImage_(root, images, value, imageName_(gid, row, c));
      });
    }
  }

  clearTriggers_();
  props.deleteAllProperties();
  console.log('Export finished.');
}

function exportTabs_(root, sheets) {
  const tabsFolder = childFolder_(root, 'tabs');
  const index = sheets.map((sheet, i) => {
    const gid = sheet.getSheetId();
    const range = sheet.getDataRange();
    const values = range.getValues();
    const display = range.getDisplayValues();
    const rich = range.getRichTextValues();
    const formulas = range.getFormulas();
    const notes = range.getNotes();

    const cells = [];
    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        const cell = { r: r + 1, c: c + 1 };
        if (display[r][c]) cell.text = display[r][c];
        const links = linksOf_(rich[r][c]);
        if (links.length) cell.links = links;
        if (formulas[r][c]) cell.formula = formulas[r][c];
        if (notes[r][c]) cell.note = notes[r][c];
        if (isImage_(values[r][c])) cell.image = imageName_(gid, r, c);
        if (Object.keys(cell).length > 2) cells.push(cell);
      }
    }
    writeFile_(tabsFolder, `${gid}.json`, JSON.stringify({ name: sheet.getName(), gid, cells }));

    return {
      index: i,
      name: sheet.getName(),
      gid,
      hidden: sheet.isSheetHidden(),
      rows: values.length,
      cols: values[0].length,
      overGridImages: sheet.getImages().length,
    };
  });
  writeFile_(root, 'index.json', JSON.stringify(index, null, 2));
}

function linksOf_(rich) {
  if (!rich) return [];
  const links = [];
  const add = (url, text) => {
    if (url && !links.some((l) => l.url === url)) links.push({ url, text });
  };
  add(rich.getLinkUrl(), rich.getText());
  rich.getRuns().forEach((run) => add(run.getLinkUrl(), run.getText()));
  return links;
}

function isImage_(value) {
  return value && typeof value === 'object' && value.valueType === SpreadsheetApp.ValueType.IMAGE;
}

function imageName_(gid, r, c) {
  return `${gid}_r${r + 1}_c${c + 1}`;
}

function saveImage_(root, folder, image, baseName) {
  try {
    const url = image.getContentUrl() || image.getUrl();
    if (!url) throw new Error('no image URL available');
    let res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      res = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true,
      });
    }
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    const blob = res.getBlob();
    const type = (blob.getContentType() || 'image/jpeg').split(';')[0];
    const ext = type.split('/')[1].replace('jpeg', 'jpg');
    folder.createFile(blob.setName(`${baseName}.${ext}`));
  } catch (e) {
    const existing = root.getFilesByName('errors.txt');
    const line = `${baseName}: ${e.message}\n`;
    if (existing.hasNext()) {
      const file = existing.next();
      file.setContent(file.getBlob().getDataAsString() + line);
    } else {
      root.createFile('errors.txt', line, 'text/plain');
    }
  }
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function writeFile_(folder, name, content) {
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(content);
  else folder.createFile(name, content, 'application/json');
}

function scheduleContinue_() {
  clearTriggers_();
  ScriptApp.newTrigger('exportAll').timeBased().after(60 * 1000).create();
}

function clearTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'exportAll')
    .forEach((t) => ScriptApp.deleteTrigger(t));
}
