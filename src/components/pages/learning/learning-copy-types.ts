import type {
  AaisClientTaskStatus,
  ContentItemId,
  DocumentFontFamily,
} from "@/components/pages/learning/learning-page-types";

export type LearningCopy = {
  main: {
    heading: string;
    description: string;
  };
  brand: {
    logoLabel: string;
    accountMenu: (displayName: string) => string;
    avatar: (displayName: string) => string;
    accountInfo: (displayName: string) => string;
    exportLearnerData: string;
    deleteLearnerData: string;
    signOut: string;
  };
  guide: {
    busy: string;
    readingFiles: string;
    quickStarts: string;
    chooseFiles: string;
    uploadFile: string;
    inputLabel: string;
    inputPlaceholder: string;
    send: string;
    uploadedFiles: string;
    removeFile: (fileName: string) => string;
    localScaffold: string;
    providerFailureTitle: string;
    providerFailureMessage: string;
    guardrailFailureTitle: string;
    guardrailFailureMessage: string;
    configurationFailureTitle: string;
    configurationFailureMessage: string;
    connectionFailureTitle: string;
    connectionFailureMessage: string;
    unknownFailureTitle: string;
    unknownFailureMessage: string;
    supportCode: (diagnosticId: string) => string;
    copySupportCode: string;
    supportCodeCopied: string;
    supportCodeCopyFailed: string;
    retryAction: string;
    rewriteAction: string;
    retryQuestion: string;
    rewriteQuestion: string;
    assistant: string;
    avatar: (agentId: string, label: string) => string;
    attachmentUnavailable: string;
    inputRequired: string;
    requestIdentityUnavailable: string;
    requestAccepted: string;
    attachmentLimit: (maxFiles: number) => string;
    fileReadFailed: string;
    agentLabels: Record<string, string>;
  };
  content: {
    resize: string;
    panel: string;
    displayTab: string;
    editorTab: string;
    saveAndClose: string;
    downloading: string;
    download: string;
    displayNav: string;
    backToDisplay: string;
    back: string;
    documentFolder: (title: string) => string;
    items: Record<ContentItemId, { label: string; body: string }>;
    taskCards: {
      listLabel: string;
      progress: (completed: number, total: number) => string;
      ordinal: (index: number) => string;
      phase: Record<"training" | "practice", string>;
      status: Record<AaisClientTaskStatus, string>;
      lockedHint: string;
      enter: string;
      continue: string;
      review: string;
      complete: string;
      completing: string;
      actionFailed: string;
      lockedButton: (title: string) => string;
      enterButton: (title: string) => string;
      continueButton: (title: string) => string;
      reviewButton: (title: string) => string;
      completeButton: (title: string) => string;
    };
  };
  editor: {
    titleLabel: string;
    titlePlaceholder: string;
    toolbarLabel: string;
    fontLabel: string;
    fontFamilies: Record<DocumentFontFamily, string>;
    sizeLabel: string;
    bold: string;
    italic: string;
    underline: string;
    alignLeft: string;
    alignCenter: string;
    alignRight: string;
    bulletList: string;
    numberedList: string;
    heading1: string;
    heading2: string;
    heading3: string;
    emptyPrompt: string;
    inputLabel: string;
  };
  document: {
    saveQueuedWhileSaving: string;
    saveResearchPaused: string;
    saving: string;
    saved: string;
    saveFailed: string;
    archiveFailed: string;
    saveQueued: string;
    downloadPreparing: string;
    downloadReady: string;
    downloadFailed: string;
    justSaved: string;
    untitled: string;
  };
  workspace: {
    sessionUnavailable: string;
  };
  account: {
    waitForOperation: string;
    waitForExportOperation: string;
    signingOut: string;
    researchSyncRequired: string;
    signOutFailed: string;
    exporting: string;
    exported: string;
    exportFailed: string;
    deleteConfirmation: string;
    deleting: string;
    deleted: string;
    deleteFailed: string;
  };
  researchBoundary: {
    heading: string;
    initializing: string;
    offlineOrTemporary: string;
    terminalBlocked: string;
    safeExit: string;
    safeExiting: string;
    safeExitFailed: string;
  };
};
