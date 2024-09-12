import { execFile } from "child_process";
import { dirname } from "path";
import { promisify } from "util";
import * as vscode from "vscode";

const execFileP = promisify(execFile);

async function findModificationTimeByLine(path: string) {
  let blameOutput;
  try {
    blameOutput = await execFileP("git", ["blame", "-t", path], {
      cwd: dirname(path),
    });
  } catch (e) {
    if (e instanceof Error) {
      console.error(`Could not run git blame: ${e.message}`);
    } else {
      console.error(`Could not run git blame: ${e}`);
    }
    return [];
  }

  const times = blameOutput.stdout.split("\n").map((line) => {
    const timestampMatch = line.match(/\d{10}/);

    if (timestampMatch === null) {
      // That's weird
      return null;
    }

    return parseInt(timestampMatch[0]) * 1000;
  });

  return times;
}

const NUM_BUCKETS = 10;

type Bucket = number;

const decorationTypes: Map<Bucket, vscode.TextEditorDecorationType> = new Map();

function initDecorationTypes() {
  for (let bucket = 0; bucket < NUM_BUCKETS; bucket++) {
    decorationTypes.set(
      bucket,
      vscode.window.createTextEditorDecorationType({
        backgroundColor: `rgba(127, 0, 0, ${bucket / NUM_BUCKETS})`,
        isWholeLine: true,
      }),
    );
  }
}

initDecorationTypes();

const MAXED_DECORATION_TYPE = vscode.window.createTextEditorDecorationType({
  backgroundColor: "rgba(127, 0, 0, 1)",
  isWholeLine: true,
});

function durationToBucket(duration: number): Bucket {
  const years = duration / (24 * 60 * 60 * 1000);
  const halfLife =
    vscode.workspace.getConfiguration().get<number>("agingLines.halfLife") ??
    365;
  const value = 1 - Math.pow(0.5, years / halfLife);
  const bucket = Math.floor(value * NUM_BUCKETS);
  console.log("durationToBucket", years, bucket);
  return bucket;
}

function getDecorationType(timeSinceModification: number) {
  const bucket = durationToBucket(timeSinceModification);
  return decorationTypes.get(bucket) ?? MAXED_DECORATION_TYPE;
}

export function activate(context: vscode.ExtensionContext) {
  let activeEditor = vscode.window.activeTextEditor;

  const showDecorations = async (editor: vscode.TextEditor) => {
    const modificationTimeByLine = await findModificationTimeByLine(
      editor.document.uri.fsPath,
    );
    const latestModificationTime = Math.max(
      ...(modificationTimeByLine.filter((time) => time !== null) as number[]),
    );

    const decorationsByDecorationType: Map<
      vscode.TextEditorDecorationType,
      { range: vscode.Range }[]
    > = new Map();

    for (const [
      lineNumber,
      modificationTime,
    ] of modificationTimeByLine.entries()) {
      if (modificationTime === null) {
        continue;
      }

      const decorationType = getDecorationType(
        latestModificationTime - modificationTime,
      );
      const decoration = {
        range: new vscode.Range(lineNumber, 0, lineNumber, 0),
      };

      const ranges = decorationsByDecorationType.get(decorationType);
      if (ranges) {
        ranges.push(decoration);
      } else {
        decorationsByDecorationType.set(decorationType, [decoration]);
      }
    }

    for (const [
      decorationType,
      decorations,
    ] of decorationsByDecorationType.entries()) {
      editor.setDecorations(decorationType, decorations);
    }
  };

  const hideDecorations = (editor: vscode.TextEditor) => {
    for (const decorationType of decorationTypes.values()) {
      editor.setDecorations(decorationType, []);
    }
  };

  let enabled = false;

  const updateDecorations = async () => {
    if (!activeEditor) {
      return;
    }

    if (enabled) {
      showDecorations(activeEditor);
    } else {
      hideDecorations(activeEditor);
    }
  };

  vscode.commands.registerCommand("agingLines.toggle", () => {
    enabled = !enabled;
    updateDecorations();
  });

  let timeout: NodeJS.Timeout | undefined = undefined;

  const triggerUpdateDecorations = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    timeout = setTimeout(updateDecorations, 500);
  };

  if (activeEditor) {
    triggerUpdateDecorations();
  }

  vscode.window.onDidChangeActiveTextEditor(
    (editor) => {
      activeEditor = editor;
      if (editor) {
        triggerUpdateDecorations();
      }
    },
    null,
    context.subscriptions,
  );

  vscode.workspace.onDidChangeTextDocument(
    (event) => {
      if (activeEditor && event.document === activeEditor.document) {
        triggerUpdateDecorations();
      }
    },
    null,
    context.subscriptions,
  );

  vscode.workspace.onDidChangeConfiguration(
    () => {
      initDecorationTypes();
      triggerUpdateDecorations();
    },
    null,
    context.subscriptions,
  );
}
