/**
 * @file userscript/languageBundleOverrides.ts
 * 文件职责：对已发布固定语言资源生成并应用本地词典的小型覆盖，避免未发布内容伪装成远端资源。
 * 主要内容：分别比较稳定消息、旧文案与有序匹配模板，记录新增、修改与删除；注册前不可变合并，不污染固定资源或 GM 缓存。
 * 模块边界：纯数据转换，不读取文件、不请求网络、不决定资源提交号；构建期计算覆盖，语言装载器负责解压并注册。
 */
import type {UiLanguageBundle} from '@/src/core/i18n/types';

export interface UiLanguageBundleOverride {
    messages?: Record<string, string>;
    legacyText?: Record<string, string>;
    removed?: Partial<Record<'messages' | 'legacyText', string[]>>;
    legacyPatterns?: Partial<UiLanguageBundle['legacyPatterns']>;
}

export function createUiLanguageBundleOverride(pinned: UiLanguageBundle, current: UiLanguageBundle): UiLanguageBundleOverride | undefined {
    const override: UiLanguageBundleOverride = {};
    for (const field of ['messages', 'legacyText'] as const) {
        const updates = Object.fromEntries(Object.entries(current[field])
            .filter(([key, value]) => !Object.hasOwn(pinned[field], key) || pinned[field][key] !== value));
        if (Object.keys(updates).length) override[field] = updates;
        const removed = Object.keys(pinned[field]).filter(key => !Object.hasOwn(current[field], key));
        if (removed.length) override.removed = {...override.removed, [field]: removed};
    }
    for (const phase of ['early', 'late'] as const) {
        if (JSON.stringify(pinned.legacyPatterns[phase]) !== JSON.stringify(current.legacyPatterns[phase])) {
            override.legacyPatterns = {...override.legacyPatterns, [phase]: current.legacyPatterns[phase]};
        }
    }
    return Object.keys(override).length ? override : undefined;
}

export function applyUiLanguageBundleOverride(pinned: UiLanguageBundle, override: UiLanguageBundleOverride): UiLanguageBundle {
    const merged = {...pinned};
    for (const field of ['messages', 'legacyText'] as const) {
        const removed = new Set(override.removed?.[field]);
        merged[field] = {...Object.fromEntries(Object.entries(pinned[field]).filter(([key]) => !removed.has(key))), ...override[field]};
    }
    merged.legacyPatterns = {...pinned.legacyPatterns, ...override.legacyPatterns};
    return merged;
}
