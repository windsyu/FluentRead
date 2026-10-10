import {describe, expect, it} from 'vitest';
import {normalizeOpenAIResponsesEndpoint} from '@/src/core/config/openaiResponses';
import {defaultModels, models, options, services, servicesType} from '@/src/core/config/catalog';
import {urls} from '@/src/core/config/constants';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {isHarnessService, normalizeHarnessPreferences} from '@/src/core/config/harness';
import {normalizeWritingPreferences} from '@/src/core/config/writing';
import {resolveModelVisionCapability, supportsVisionTransport} from '@/src/core/config/vision';
import {isConfigImportValid, prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';
import {projectDriveSyncConfig} from '@/src/core/config/driveSync';
import {restoreRestorableConfig, toRestorableConfig} from '@/src/services/config/history';
import {createApiKeyCheckRevision} from '@/src/core/config/apiKeyCheckIdentity';
import {sanitizeConfigCredentials} from '@/src/core/config/credentials';
import {getServiceWebsite} from '@/src/ui/view-model/serviceCatalog';
import {hasSavedServiceConfiguration} from '@/src/ui/view-model/serviceLibrary';

const service = services.openaiResponses;

describe('独立 openai responses 服务配置', () => {
    it.each([
        [' https://gateway.example ', 'https://gateway.example/v1/responses'],
        ['https://gateway.example/', 'https://gateway.example/v1/responses'],
        ['https://gateway.example/v1/', 'https://gateway.example/v1/responses'],
        ['http://localhost:8000/prefix/v2', 'http://localhost:8000/prefix/v2/responses'],
        ['https://gateway.example/v1/responses///#ignored', 'https://gateway.example/v1/responses'],
        ['https://gateway.example/v1/chat/completions/', 'https://gateway.example/v1/responses'],
        ['https://gateway.example/custom/exact/', 'https://gateway.example/custom/exact/'],
        ['https://gateway.example/v1?route=a%2fb&route=c+space#ignored', 'https://gateway.example/v1/responses?route=a%2fb&route=c+space'],
    ])('规范化 %s 为 %s 且重复执行稳定', (input, output) => {
        expect(normalizeOpenAIResponsesEndpoint(input)).toBe(output);
        expect(normalizeOpenAIResponsesEndpoint(output)).toBe(output);
    });

    it.each(['', 'not-a-url', '/v1/responses', 'ftp://gateway.example/v1', 'file:///v1/responses'])('拒绝无效端点 %s', input => {
        expect(() => normalizeOpenAIResponsesEndpoint(input)).toThrow(/HTTP\(S\)/u);
    });

    it('单数 response 明确提示复数修正，不静默补全', () => {
        expect(() => normalizeOpenAIResponsesEndpoint('https://gateway.example/v1/response/')).toThrow(/\/responses（复数）/u);
    });

    it('独立服务复用 OpenAI 模型目录但不改变旧服务或自定义配置', () => {
        expect(options.services.find(option => option.value === service)?.label).toBe('openai responses');
        for (const supports of ['isAI', 'isAiSdk', 'isUseToken', 'isUseModel', 'isUseProxy'] as const) {
            expect(servicesType[supports](service)).toBe(true);
        }
        expect(defaultModels.get(service)).toBe(defaultModels.get(services.openai));
        expect(models.get(service)).toEqual(models.get(services.openai));
        expect(models.get(service)).not.toBe(models.get(services.openai));
        expect(urls[service]).toBe('https://api.openai.com/v1/responses');
        expect(urls[services.openai]).toBe('https://api.openai.com/v1/chat/completions');
        const legacy = normalizeConfig({service: services.newapi, newApiUrl: 'https://old.example/v1',
            customOpenAIProviders: [{id: 'custom:old', name: '旧服务', endpoint: 'https://old.example/v1/chat/completions', models: ['old-model']}],
            proxy: {[services.openai]: 'https://old-proxy.example/chat'}, token: {[services.newapi]: 'fixture-old-key'}});
        expect(legacy.service).toBe(services.newapi);
        expect(legacy.newApiUrl).toBe('https://old.example/v1');
        expect(legacy.customOpenAIProviders[0].endpoint).toBe('https://old.example/v1/chat/completions');
        expect(legacy.proxy[services.openai]).toBe('https://old-proxy.example/chat');
        expect(legacy.model[service]).toBe(defaultModels.get(service));
        expect(legacy.system_role[service]).toBe(new Config().system_role[services.openai]);
    });

    it('不开放尚未接入原生 Responses 的阅读、写作或图片识别网关', () => {
        expect(isHarnessService(service)).toBe(false);
        expect(normalizeHarnessPreferences({service}).service).toBe('');
        expect(normalizeWritingPreferences({service}).service).toBe('');
        expect(supportsVisionTransport(service, 'gpt-4.1')).toBe(false);
        expect(resolveModelVisionCapability(service, 'gpt-4.1', {[service]: {'gpt-4.1': true}})).toBe('unsupported');
        expect(isHarnessService(services.openai)).toBe(true);
    });

    it('服务参数在完整导出、导入与历史中往返，普通云偏好不拆出连接配置', () => {
        const source = normalizeConfig({...new Config(), service,
            proxy: {[service]: 'https://self-hosted.example/v1'},
            token: {[service]: 'fixture-responses-key', [services.openai]: 'fixture-chat-key'},
            model: {[service]: 'custom-response-model'}, system_role: {[service]: 'fixture-system'},
            user_role: {[service]: 'fixture-user'}, customBody: {[service]: '{"max_output_tokens":100}'}});
        const exported = prepareConfigForExport(source);
        expect(isConfigImportValid(exported)).toBe(true);
        const imported = prepareConfigForImport(exported, new Config());
        expect(imported.service).toBe(service);
        for (const field of ['proxy', 'token', 'model', 'system_role', 'user_role', 'customBody'] as const) {
            expect(imported[field][service]).toBe(source[field][service]);
        }
        expect(imported.token[services.openai]).toBe('fixture-chat-key');
        const restored = restoreRestorableConfig(toRestorableConfig(source), source);
        expect(restored.proxy[service]).toBe(source.proxy[service]);
        expect(restored.token[service]).toBe(source.token[service]);
        expect(projectDriveSyncConfig(source as unknown as Record<string, unknown>)).not.toHaveProperty('proxy');
        expect(projectDriveSyncConfig(source as unknown as Record<string, unknown>, true)).toHaveProperty(['proxy', service], source.proxy[service]);
    });

    it('独立连接检查指纹、已保存识别与安全官网跳转沿用现有机制', () => {
        const source = new Config();
        expect(hasSavedServiceConfiguration(service, source)).toBe(false);
        source.proxy[service] = 'https://gateway.example/v1?secret=fixture';
        expect(hasSavedServiceConfiguration(service, source)).toBe(true);
        const revision = createApiKeyCheckRevision(source, service);
        expect(revision).not.toBe(createApiKeyCheckRevision(source, services.openai));
        expect(revision).not.toBe(createApiKeyCheckRevision({...source, proxy: {[service]: 'https://other.example/v1'}}, service));
        expect(getServiceWebsite(service, {endpoint: source.proxy[service]})).toEqual({url: 'https://gateway.example/', kind: 'website'});
        expect(getServiceWebsite(service)).toEqual({url: 'https://platform.openai.com/', kind: 'documentation'});
    });

    it('公开导入与历史恢复按原生规范地址保留等价凭据，改道不携带旧 Key', () => {
        const current = normalizeConfig({...new Config(), service,
            proxy: {[service]: 'https://self-hosted.example'},
            token: {[service]: 'fixture-responses-key', [services.openai]: 'fixture-chat-key'}});
        const publicCopy = sanitizeConfigCredentials(current);
        for (const endpoint of ['https://self-hosted.example/v1', 'https://self-hosted.example/v1/responses/',
            'https://self-hosted.example/v1/chat/completions']) {
            const imported = prepareConfigForImport({...publicCopy, proxy: {[service]: endpoint}}, current);
            expect(imported.token[service]).toBe('fixture-responses-key');
            expect(imported.token[services.openai]).toBe('fixture-chat-key');
            const restored = restoreRestorableConfig({...toRestorableConfig(current), proxy: {[service]: endpoint}}, current);
            expect(restored.token[service]).toBe('fixture-responses-key');
        }
        const changed = {...publicCopy, proxy: {[service]: 'https://other-host.example/v1'}};
        expect(prepareConfigForImport(changed, current).token).not.toHaveProperty(service);
        expect(prepareConfigForImport(changed, current).token[services.openai]).toBe('fixture-chat-key');
        expect(restoreRestorableConfig(changed, current).token).not.toHaveProperty(service);
        const rebound = prepareConfigForImport({...changed, token: {[service]: 'fixture-new-host-key'}}, current);
        expect(rebound.token[service]).toBe('fixture-new-host-key');
    });
});
