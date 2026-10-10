/**
 * @file src/core/config/harness.ts
 * 文件职责：定义 Harness 学习辅助功能的动作注册表、配置类型、默认值与纯规范化规则。
 * 主要内容：提供 HarnessActionId/HarnessPreferences、动作注册表、支持服务判断和规范化函数，限制触发方式、快捷键、悬停延迟、服务/模型覆盖和动作白名单、上下文长度和学习难度，并定义可编辑提示词、默认模板、占位符替换规则和包含当前服务请求头及多 Key 凭据的阅读模型缓存标识。
 * 网关边界：独立 Responses 服务首期仅接入翻译，因此从阅读与共用本规则的写作服务选择中排除，避免把原生接口发送到尚未适配的 Chat 网关。
 * 模块边界：本文件只处理领域数据，不读取浏览器存储、不发起 AI 请求，也不决定选区或网页生命周期。
 */
import {DEFAULT_HARNESS_ACTION_PROMPTS, DEFAULT_HARNESS_SYSTEM_PROMPT, HARNESS_PROMPT_MAX_LENGTH} from '../harness/prompts';
export {DEFAULT_HARNESS_ACTION_PROMPTS, DEFAULT_HARNESS_SYSTEM_PROMPT, HARNESS_PROMPT_MAX_LENGTH, HARNESS_PROMPT_VARIABLES, getDefaultHarnessPrompt, resolveHarnessPrompt, renderHarnessPrompt, type HarnessPromptKind} from '../harness/prompts';
import {parseHotkey} from '../hotkey';
import {customModelString, resolveConfiguredModel, services, servicesType} from './catalog';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId, type CustomOpenAIProvider} from './customOpenAI';

export const HARNESS_ACTIONS = [
    {id: 'meaning', label: '读懂', description: '解释这段内容在说什么。'},
    {id: 'grammar', label: '词性与句法', description: '拆解句子结构和关键语法。'},
    {id: 'usage', label: '用法', description: '说明词语或表达的自然用法。'},
    {id: 'practice', label: '练习', description: '根据内容生成一个小练习。'},
] as const;

export type HarnessActionId = typeof HARNESS_ACTIONS[number]['id'];
export type HarnessContextMode = 'paragraph' | 'selection';
export type HarnessExplanationDepth = 'concise' | 'detailed';

export interface HarnessPreferences {
    enabled: boolean;
    trigger: 'click' | 'hover' | 'shortcut';
    customHotkey: string;
    hoverDelay: number;
    service: string;
    model: string;
    defaultAction: HarnessActionId;
    actions: HarnessActionId[];
    contextMode: HarnessContextMode;
    maxContextChars: number;
    explanationDepth: HarnessExplanationDepth;
    learningLevel: 'beginner' | 'intermediate' | 'advanced';
    memoryEnabled: boolean;
    systemPrompt: string;
    actionPrompts: Record<HarnessActionId, string>;
}

export const DEFAULT_HARNESS_PREFERENCES: HarnessPreferences = {
    enabled: false,
    trigger: 'click',
    customHotkey: 'Alt+R',
    hoverDelay: 600,
    service: '',
    model: '',
    defaultAction: 'meaning',
    actions: HARNESS_ACTIONS.map((action) => action.id),
    contextMode: 'paragraph',
    maxContextChars: 1500,
    explanationDepth: 'concise',
    learningLevel: 'intermediate',
    memoryEnabled: false,
    systemPrompt: DEFAULT_HARNESS_SYSTEM_PROMPT,
    actionPrompts: {...DEFAULT_HARNESS_ACTION_PROMPTS},
};

// Responses 首期只接入翻译；阅读与写作的独立 model gateway 仍使用 Chat 协议。
const HARNESS_UNSUPPORTED_SERVICES = new Set([services.huanYuanTranslation, services.openaiResponses]);

/** Harness 支持兼容会话及原生 Claude/Gemini，目录与 gateway 共用此规则。 */
export function isHarnessService(service: unknown, customProviders: readonly CustomOpenAIProvider[] = []): service is string {
    if (typeof service !== 'string' || service.length > 128) return false;
    if (isCustomOpenAIProviderId(service)) return isConfiguredCustomOpenAIProvider(customProviders, service);
    return servicesType.isAI(service) && !HARNESS_UNSUPPORTED_SERVICES.has(service);
}

const HARNESS_ACTION_IDS = new Set<HarnessActionId>(HARNESS_ACTIONS.map((action) => action.id));

export function normalizeHarnessPreferences(value: unknown, customProviders: readonly CustomOpenAIProvider[] = []): HarnessPreferences {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<HarnessPreferences>
        : {};
    const hotkey = typeof source.customHotkey === 'string' ? source.customHotkey.trim().slice(0, 100) : '';
    const hoverDelay = source.hoverDelay;
    const actions = Array.isArray(source.actions)
        ? [...new Set(source.actions.filter((action): action is HarnessActionId => (
            typeof action === 'string' && HARNESS_ACTION_IDS.has(action as HarnessActionId)
        )))]
        : [...DEFAULT_HARNESS_PREFERENCES.actions];
    if (!actions.includes('meaning')) actions.unshift('meaning');
    const rawChars = typeof source.maxContextChars === 'number' ? source.maxContextChars : Number(source.maxContextChars);
    const promptSource = source.actionPrompts && typeof source.actionPrompts === 'object' && !Array.isArray(source.actionPrompts) ? source.actionPrompts : {} as Partial<Record<HarnessActionId, unknown>>;
    const normalizePrompt = (value: unknown, fallback: string): string => typeof value === 'string' ? value.slice(0, HARNESS_PROMPT_MAX_LENGTH) : fallback;
    return {
        systemPrompt: normalizePrompt(source.systemPrompt, DEFAULT_HARNESS_SYSTEM_PROMPT),
        actionPrompts: Object.fromEntries(HARNESS_ACTIONS.map(({id}) => [id, normalizePrompt(promptSource[id], DEFAULT_HARNESS_ACTION_PROMPTS[id])])) as Record<HarnessActionId, string>,
        enabled: source.enabled === true,
        trigger: source.trigger === 'hover' || source.trigger === 'shortcut' ? source.trigger : 'click',
        customHotkey: parseHotkey(hotkey).isValid ? hotkey : DEFAULT_HARNESS_PREFERENCES.customHotkey,
        hoverDelay: typeof hoverDelay === 'number' && Number.isFinite(hoverDelay) ? Math.min(3000, Math.max(200, Math.round(hoverDelay))) : 600,
        service: isHarnessService(typeof source.service === 'string' ? source.service.trim() : '', customProviders) ? source.service!.trim().slice(0, 128) : '',
        model: typeof source.model === 'string' && source.model.trim() !== customModelString ? source.model.trim().slice(0, 128) : '',
        defaultAction: typeof source.defaultAction === 'string' && HARNESS_ACTION_IDS.has(source.defaultAction as HarnessActionId) && actions.includes(source.defaultAction as HarnessActionId)
            ? source.defaultAction as HarnessActionId
            : 'meaning',
        actions,
        contextMode: source.contextMode === 'selection' ? 'selection' : 'paragraph',
        maxContextChars: Number.isFinite(rawChars) ? Math.min(4000, Math.max(500, Math.round(rawChars))) : 1500,
        explanationDepth: source.explanationDepth === 'detailed' ? 'detailed' : 'concise',
        learningLevel: source.learningLevel === 'beginner' || source.learningLevel === 'advanced'
            ? source.learningLevel
            : 'intermediate',
        memoryEnabled: source.memoryEnabled === true,
    };
}

/** 仅用于内存比较，不持久化或展示；无关界面配置刷新不能清除阅读回答。 */
export function getHarnessModelCacheKey(config: {
    harness: Pick<HarnessPreferences, 'service' | 'model'>;
    service: string;
    model: Record<string, string>;
    customModel: Record<string, string>;
    token: Record<string, string>;
    apiKeys?: Record<string, string[]>;
    apiKeyRotationEnabled?: Record<string, boolean>;
    customHeaders?: Record<string, string>;
    proxy: Record<string, string>;
    on: boolean;
    uiLanguage: string;
    modelThinking: unknown;
    customOpenAIProviders: unknown;
    custom: string;
    newApiUrl: string;
    azureOpenaiEndpoint: string;
    deepseekApiType: string;
    minimaxBillingPlan: string;
    minimaxRegion: string;
    mimoBillingPlan: string;
    mimoRegion: string;
}): string {
    const service = config.harness.service || config.service;
    const model = config.harness.model || resolveConfiguredModel(config.model[service], config.customModel[service]);
    return JSON.stringify([
        config.on, config.uiLanguage, service, model, config.token[service], config.proxy[service],
        config.modelThinking, config.customOpenAIProviders, config.custom, config.newApiUrl,
        config.azureOpenaiEndpoint, config.deepseekApiType, config.minimaxBillingPlan,
        config.minimaxRegion, config.mimoBillingPlan, config.mimoRegion,
        config.apiKeys?.[service], config.apiKeyRotationEnabled?.[service], config.customHeaders?.[service],
    ]);
}
