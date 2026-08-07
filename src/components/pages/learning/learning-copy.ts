import type { Locale } from "@/data/aais";
import type {
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
    offlineScaffold: string;
    assistant: string;
    avatar: (agentId: string, label: string) => string;
    attachmentUnavailable: string;
    inputRequired: string;
    requestAccepted: string;
    requestUnavailable: string;
    requestErrorAlert: string;
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

export const learningCopyByLocale: Record<Locale, LearningCopy> = {
  "zh-CN": {
    main: {
      heading: "CAAIS 学习工作台",
      description: "使用智能导学、内容展示和文档编辑完成认知学徒学习任务。",
    },
    brand: {
      logoLabel: "CAAIS 标志",
      accountMenu: (displayName) => `${displayName} 账户菜单`,
      avatar: (displayName) => `${displayName} 原创英雄人脸头像`,
      accountInfo: (displayName) => `${displayName} 账户信息`,
      exportLearnerData: "导出学习数据",
      deleteLearnerData: "删除学习数据",
      signOut: "退出",
    },
    guide: {
      busy: "智能导学处理中...",
      readingFiles: "文件正在读取...",
      quickStarts: "元认知快速开始",
      chooseFiles: "选择上传文件",
      // Preserve the pre-existing accessible control name for the upload
      // trigger. Its visible button label remains the localized `chooseFiles`.
      uploadFile: "Upload file",
      inputLabel: "向智能导学输入你的想法",
      inputPlaceholder: "输入你的想法...",
      send: "发送",
      uploadedFiles: "已上传文件",
      removeFile: (fileName) => `移除 ${fileName}`,
      offlineScaffold: "离线支架模式",
      assistant: "AI 助教",
      avatar: (_agentId, label) => `${label}大学教育风格头像`,
      attachmentUnavailable: "上传文件不可用。",
      inputRequired: "请输入你的想法后再发送。",
      requestAccepted: "CAAIS 已收到，多智能体链路正在处理。",
      requestUnavailable: "智能服务暂时不可用，已保留你的问题。请稍后重试。",
      requestErrorAlert: "智能服务暂时不可用，已保留你的问题。",
      attachmentLimit: (maxFiles) => `一次最多上传 ${maxFiles} 个文件。`,
      fileReadFailed: "文件未能读取。",
      agentLabels: {
        A1: "小张",
        A2: "教授",
        A3: "监督智能体",
        A4: "反思智能体",
      },
    },
    content: {
      resize: "调整内容展示区域宽度",
      panel: "学习内容与文档",
      displayTab: "内容展示",
      editorTab: "文档编辑",
      saveAndClose: "保存并关闭",
      downloading: "下载中...",
      download: "下载到本地",
      displayNav: "内容展示",
      backToDisplay: "返回内容展示",
      back: "返回",
      documentFolder: (title) => `历史文档文件夹：${title}`,
      items: {
        platform: {
          label: "平台介绍",
          body: "CAAIS平台是一个基于认知学徒理论搭建的，AI赋能的学习平台……",
        },
        theory: {
          label: "理论知识",
          body: "认知学徒理论强调专家示范、实践指导、支架支持、清晰表达与反思比较。",
        },
        history: {
          label: "历史文档",
          body: "历史文档用于保存学习过程、重要资料和后续 pilot study 可回顾的记录。",
        },
      },
    },
    editor: {
      titleLabel: "文档标题",
      titlePlaceholder: "输入标题...",
      toolbarLabel: "文档格式工具",
      fontLabel: "字体",
      fontFamilies: {
        system: "默认",
        serif: "衬线",
        mono: "等宽",
      },
      sizeLabel: "字号",
      bold: "加粗",
      italic: "斜体",
      underline: "下划线",
      alignLeft: "左对齐",
      alignCenter: "居中",
      alignRight: "右对齐",
      bulletList: "项目符号",
      numberedList: "编号列表",
      heading1: "一级标题",
      heading2: "二级标题",
      heading3: "三级标题",
      emptyPrompt: "在这里开始记录...",
      inputLabel: "在这里写下任务理解、计划、执行过程或最终产出。",
    },
    document: {
      saveQueuedWhileSaving: "正在保存文档，最新更改已排队。",
      saveResearchPaused: "研究记录连接已暂停，文档更改仍待保存。",
      saving: "正在保存文档...",
      saved: "文档已保存。",
      saveFailed: "任务过程记录未能保存到后端。",
      archiveFailed: "文档未能归档，工作区内容已保留。",
      saveQueued: "文档更改待保存。",
      downloadPreparing: "正在准备下载...",
      downloadReady: "文档下载已准备。",
      downloadFailed: "文档下载未能完成，请稍后重试。",
      justSaved: "刚刚保存",
      untitled: "未命名文档",
    },
    workspace: {
      sessionUnavailable: "学习记录服务暂时不可用，本页会保留当前输入但不会完成持久化。",
    },
    account: {
      waitForOperation: "请等待当前保存、下载或智能体操作完成后再退出。",
      signingOut: "正在退出...",
      researchSyncRequired: "研究事件尚未安全同步，请保持联网并稍后重试退出。",
      signOutFailed: "退出未完成，服务器会话仍保持有效。请恢复连接后重试。",
      exporting: "正在导出学习数据...",
      exported: "学习数据已导出。",
      exportFailed: "学习数据导出未能完成，请稍后重试。",
      deleteConfirmation: "确定要删除当前学习数据吗？此操作会清除你的学习记录，但不会删除账号。",
      deleting: "正在删除学习数据...",
      deleted: "学习数据已删除。",
      deleteFailed: "学习数据删除未能完成，请稍后重试。",
    },
    researchBoundary: {
      heading: "CAAIS 研究会话保护",
      initializing: "正在建立受控研究会话，请稍候。",
      offlineOrTemporary: "研究记录连接暂时不可用。为避免产生未记录操作，学习工作台已暂停，并将在连接恢复后自动继续。",
      terminalBlocked: "本次研究会话不可继续。请停止操作并联系研究人员。",
      safeExit: "安全退出到登录页",
      safeExiting: "正在安全退出...",
      safeExitFailed: "安全退出暂时失败，请恢复连接后重试。",
    },
  },
  "en-US": {
    main: {
      heading: "CAAIS Learning Workspace",
      description: "Use AI guidance, learning content, and document editing to complete Cognitive Apprenticeship learning tasks.",
    },
    brand: {
      logoLabel: "CAAIS logo",
      accountMenu: (displayName) => `${displayName} account menu`,
      avatar: (displayName) => `${displayName} original hero avatar`,
      accountInfo: (displayName) => `${displayName} account information`,
      exportLearnerData: "Export learning data",
      deleteLearnerData: "Delete learning data",
      signOut: "Sign out",
    },
    guide: {
      busy: "AI guide is thinking...",
      readingFiles: "Reading files...",
      quickStarts: "Metacognitive quick starts",
      chooseFiles: "Choose files to upload",
      uploadFile: "Upload file",
      inputLabel: "Share your thinking with the AI guide",
      inputPlaceholder: "Share your thoughts...",
      send: "Send",
      uploadedFiles: "Uploaded files",
      removeFile: (fileName) => `Remove ${fileName}`,
      offlineScaffold: "Offline scaffold mode",
      assistant: "AI teaching assistant",
      avatar: (_agentId, label) => `${label} university-education avatar`,
      attachmentUnavailable: "The selected file cannot be uploaded.",
      inputRequired: "Enter your thoughts before sending.",
      requestAccepted: "CAAIS received your request; the multi-agent flow is working on it.",
      requestUnavailable: "The AI service is temporarily unavailable. Your question has been kept; please try again shortly.",
      requestErrorAlert: "The AI service is temporarily unavailable.",
      attachmentLimit: (maxFiles) => `You can upload up to ${maxFiles} files at once.`,
      fileReadFailed: "The file could not be read.",
      agentLabels: {
        A1: "Xiao Zhang",
        A2: "Professor",
        A3: "Supervision Agent",
        A4: "Reflection Agent",
      },
    },
    content: {
      resize: "Resize the learning-content panel",
      panel: "Learning content and documents",
      displayTab: "Learning content",
      editorTab: "Document editor",
      saveAndClose: "Save and close",
      downloading: "Preparing download...",
      download: "Download to device",
      displayNav: "Learning content",
      backToDisplay: "Back to learning content",
      back: "Back",
      documentFolder: (title) => `Saved document: ${title}`,
      items: {
        platform: {
          label: "About CAAIS",
          body: "CAAIS is an AI-enabled learning platform built on Cognitive Apprenticeship theory…",
        },
        theory: {
          label: "Theory",
          body: "Cognitive Apprenticeship emphasizes expert modelling, guided practice, scaffolding, articulation, and reflective comparison.",
        },
        history: {
          label: "Saved documents",
          body: "Saved documents preserve the learning process, important materials, and records available for a later pilot-study review.",
        },
      },
    },
    editor: {
      titleLabel: "Document title",
      titlePlaceholder: "Enter a title...",
      toolbarLabel: "Document formatting tools",
      fontLabel: "Font",
      fontFamilies: {
        system: "System",
        serif: "Serif",
        mono: "Monospace",
      },
      sizeLabel: "Text size",
      bold: "Bold",
      italic: "Italic",
      underline: "Underline",
      alignLeft: "Align left",
      alignCenter: "Align center",
      alignRight: "Align right",
      bulletList: "Bulleted list",
      numberedList: "Numbered list",
      heading1: "Heading 1",
      heading2: "Heading 2",
      heading3: "Heading 3",
      emptyPrompt: "Start writing here...",
      inputLabel: "Write your task understanding, plan, process, or final output here.",
    },
    document: {
      saveQueuedWhileSaving: "The document is saving; your latest change is queued.",
      saveResearchPaused: "The research-recording connection is paused; document changes are still waiting to be saved.",
      saving: "Saving document...",
      saved: "Document saved.",
      saveFailed: "The task-process record could not be saved to the server.",
      archiveFailed: "The document could not be archived. Its workspace content has been retained.",
      saveQueued: "Document changes are waiting to be saved.",
      downloadPreparing: "Preparing download...",
      downloadReady: "Your document download is ready.",
      downloadFailed: "The document could not be downloaded. Please try again shortly.",
      justSaved: "Saved just now",
      untitled: "Untitled document",
    },
    workspace: {
      sessionUnavailable: "The learning-record service is temporarily unavailable. This page will retain your input, but it cannot be saved yet.",
    },
    account: {
      waitForOperation: "Wait for the current save, download, or AI operation to finish before signing out.",
      signingOut: "Signing out...",
      researchSyncRequired: "Research events have not synced safely. Stay online and try signing out again shortly.",
      signOutFailed: "Sign-out did not finish, and the server session is still active. Restore your connection and try again.",
      exporting: "Exporting learning data...",
      exported: "Learning data exported.",
      exportFailed: "Learning data could not be exported. Please try again shortly.",
      deleteConfirmation: "Delete your current learning data? This removes your learning records but does not delete your account.",
      deleting: "Deleting learning data...",
      deleted: "Learning data deleted.",
      deleteFailed: "Learning data could not be deleted. Please try again shortly.",
    },
    researchBoundary: {
      heading: "CAAIS Research Session Protection",
      initializing: "A controlled research session is being established. Please wait.",
      offlineOrTemporary: "The research-record connection is temporarily unavailable. To prevent unrecorded actions, the learning workspace is paused and will resume automatically when the connection is restored.",
      terminalBlocked: "This research session cannot continue. Please stop using the workspace and contact the research team.",
      safeExit: "Exit safely to sign in",
      safeExiting: "Exiting safely...",
      safeExitFailed: "Safe exit is temporarily unavailable. Restore the connection and try again.",
    },
  },
};

export function getLearningCopy(locale: Locale) {
  return learningCopyByLocale[locale];
}

export function getGuideAgentLabel(locale: Locale, agentId: string) {
  return learningCopyByLocale[locale].guide.agentLabels[agentId] ?? agentId;
}
