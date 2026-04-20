/**
 * @fileoverview ChatGPT 文本生成适配器
 */

import {
    sleep,
    humanType,
    safeClick,
    uploadFilesViaChooser
} from '../engine/utils.js';
import {
    normalizePageError,
    waitForInput,
    gotoWithCheck
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

// --- 配置常量 ---
const TARGET_URL = 'https://chatgpt.com/?temporary-chat=true'; // 感谢 @zhongjianhua163 提供方案
const INPUT_SELECTOR = '.ProseMirror';

/**
 * 判断模型菜单是否已经打开
 * @param {import('playwright-core').Page} page
 * @returns {Promise<boolean>}
 */
async function isModelMenuOpen(page) {
    const menuLocator = page.locator('[role="menu"] [data-testid^="model-switcher-"], [role="menu"] [data-testid="Legacy models-submenu"]');
    return await menuLocator.first().isVisible().catch(() => false);
}

/**
 * 尝试打开模型菜单
 * 说明：不同账号/页面状态下，模型按钮的 accessible name 可能不同，
 * 因此这里采用多候选定位方式，而不是只依赖 “Model selector”。
 * @param {import('playwright-core').Page} page
 * @param {object} meta
 * @returns {Promise<void>}
 */
async function openModelMenu(page, meta = {}) {
    if (await isModelMenuOpen(page)) {
        logger.info('适配器', '模型菜单已处于打开状态', meta);
        return;
    }

    const candidates = [
        {
            desc: 'Model selector 按钮',
            locator: page.getByRole('button', { name: /^Model selector/i })
        },
        {
            desc: '包含 ChatGPT 文案的按钮',
            locator: page.getByRole('button', { name: /(ChatGPT|Instant|Thinking|Pro)\s*5\.[34]/i })
        },
        {
            desc: '包含 ChatGPT 文案的任意菜单触发器',
            locator: page.locator('[aria-haspopup="menu"]').filter({ hasText: /(ChatGPT|Instant|Thinking|Pro)\s*5\.[34]/i }).first()
        },
        {
            desc: '包含 ChatGPT 文案的任意按钮',
            locator: page.locator('button').filter({ hasText: /(ChatGPT|Instant|Thinking|Pro)\s*5\.[34]/i }).first()
        }
    ];

    for (const candidate of candidates) {
        try {
            const count = await candidate.locator.count();
            if (count === 0) continue;

            logger.info('适配器', `尝试打开模型菜单: ${candidate.desc}`, meta);
            await safeClick(page, candidate.locator.first(), { bias: 'button', timeout: 5000 });
            await sleep(300, 500);

            if (await isModelMenuOpen(page)) {
                logger.info('适配器', `模型菜单已打开: ${candidate.desc}`, meta);
                return;
            }
        } catch (e) {
            logger.warn('适配器', `尝试打开模型菜单失败 (${candidate.desc}): ${e.message}`, meta);
        }
    }

    throw new Error('未能打开模型菜单');
}

/**
 * 通过 UI 选择模型
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {{id: string, testId: string}} modelConfig - 模型配置
 * @param {object} meta - 日志元数据
 * @returns {Promise<boolean>} 是否成功选择了模型
 */
async function selectModel(page, modelConfig, meta = {}) {
    const { id: modelId, testId } = modelConfig;

    try {
        logger.info('适配器', `准备选择模型: ${modelId}`, meta);

        await openModelMenu(page, meta);

        const targetMenuItem = page.locator(`[data-testid="${testId}"]`).first();
        const targetExists = await targetMenuItem.count();

        if (targetExists === 0) {
            throw new Error(`模型菜单中未找到目标项: ${testId}`);
        }

        const alreadyChecked = await targetMenuItem.getAttribute('aria-checked').catch(() => null);
        if (alreadyChecked === 'true') {
            logger.info('适配器', `目标模型已是当前模型: ${modelId}`, meta);
            await page.keyboard.press('Escape').catch(() => {});
            return true;
        }

        logger.info('适配器', `点击目标模型: ${modelId} (${testId})`, meta);
        await safeClick(page, targetMenuItem, { bias: 'button', timeout: 5000 });
        await sleep(300, 500);

        logger.info('适配器', `模型选择完成: ${modelId}`, meta);
        return true;
    } catch (e) {
        logger.error('适配器', `选择模型失败: ${modelId} | ${e.message}`, meta);
        await page.keyboard.press('Escape').catch(() => {});
        return false;
    }
}

/**
 * 执行文本生成任务
 * @param {object} context - 浏览器上下文 { page, config }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组
 * @param {string} [modelId] - 模型 ID
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{text?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;

    try {
        logger.info('适配器', '开启新会话...', meta);
        await gotoWithCheck(page, TARGET_URL);

        // 1. 等待输入框加载
        await waitForInput(page, INPUT_SELECTOR, { click: false });

        // 2. 选择模型
        if (modelId) {
            const modelConfig = manifest.models.find(m => m.id === modelId);
            if (!modelConfig) {
                logger.error('适配器', `不支持的模型: ${modelId}`, meta);
                return { error: `不支持的模型: ${modelId}` };
            }

            const selected = await selectModel(page, modelConfig, meta);
            if (!selected) {
                return { error: `模型选择失败: ${modelId}` };
            }
        }

        // 3. 上传图片 (双击 Add files and more 按钮)
        if (imgPaths && imgPaths.length > 0) {
            logger.info('适配器', `开始上传 ${imgPaths.length} 张图片...`, meta);
            const expectedUploads = imgPaths.length;
            let uploadedCount = 0;
            let processedCount = 0;

            logger.debug('适配器', '双击添加文件按钮...', meta);
            const addFilesBtn = page.getByRole('button', { name: 'Add files and more' });

            await uploadFilesViaChooser(page, addFilesBtn, imgPaths, {
                clickAction: 'dblclick',
                uploadValidator: (response) => {
                    const url = response.url();
                    if (response.status() === 200) {
                        if (url.includes('backend-api/files') && !url.includes('process_upload_stream')) {
                            uploadedCount++;
                            logger.debug('适配器', `图片上传进度: ${uploadedCount}/${expectedUploads}`, meta);
                            return false;
                        }
                        if (url.includes('backend-api/files/process_upload_stream')) {
                            processedCount++;
                            logger.info('适配器', `图片处理进度: ${processedCount}/${expectedUploads}`, meta);

                            if (processedCount >= expectedUploads) {
                                return true;
                            }
                        }
                    }
                    return false;
                }
            }, meta);
        }

        // 4. 输入提示词
        logger.info('适配器', '输入提示词...', meta);
        await safeClick(page, INPUT_SELECTOR, { bias: 'input' });
        await humanType(page, INPUT_SELECTOR, prompt);

        // 5. 先启动 SSE 监听，再发送提示词（避免竞态）
        logger.info('适配器', '监听 SSE 流获取文本...', meta);

        let textContent = '';
        let isComplete = false;
        let targetMessageId = null;

        const responsePromise = page.waitForResponse(async (response) => {
            const url = response.url();
            if (!url.includes('backend-api/f/conversation')) return false;
            if (response.request().method() !== 'POST') return false;
            if (response.status() !== 200) return false;

            try {
                const body = await response.text();
                const lines = body.split('\n');

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;

                    const dataStr = line.slice(6).trim();
                    if (dataStr === '[DONE]') {
                        isComplete = true;
                        continue;
                    }

                    try {
                        const data = JSON.parse(dataStr);

                        if (data.v?.message?.author?.role === 'assistant' &&
                            data.v?.message?.channel === 'final' &&
                            data.v?.message?.content?.content_type === 'text') {
                            targetMessageId = data.v.message.id;
                            const parts = data.v.message.content.parts;
                            textContent = (parts && parts[0]) || '';
                        }

                        if (!targetMessageId) continue;

                        if (data.o === 'append' && data.p === '/message/content/parts/0' && data.v) {
                            textContent += data.v;
                        }

                        if (Array.isArray(data.v)) {
                            for (const patch of data.v) {
                                if (patch.o === 'append' && patch.p === '/message/content/parts/0' && patch.v) {
                                    textContent += patch.v;
                                }
                                if (patch.p === '/message/status' && patch.v === 'finished_successfully') {
                                    isComplete = true;
                                }
                            }
                        }

                        if (data.type === 'message_stream_complete') {
                            isComplete = true;
                        }
                    } catch {
                        // 忽略解析错误
                    }
                }

                return isComplete;
            } catch {
                return false;
            }
        }, { timeout: waitTimeout });

        // 6. 发送提示词
        logger.debug('适配器', '发送提示词...', meta);
        await page.keyboard.press('Enter');

        logger.info('适配器', '等待生成结果...', meta);

        // 7. 等待 SSE 响应完成
        try {
            await responsePromise;
        } catch (e) {
            const pageError = normalizePageError(e, meta);
            if (pageError) return pageError;
            throw e;
        }

        if (!textContent || textContent.trim() === '') {
            logger.warn('适配器', '回复内容为空', meta);
            return { error: '回复内容为空' };
        }

        logger.info('适配器', `已获取文本内容 (${textContent.length} 字符)`, meta);
        logger.info('适配器', '文本生成完成，任务完成', meta);
        return { text: textContent.trim() };

    } catch (err) {
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;

        logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
        return { error: `生成任务失败: ${err.message}` };
    } finally { }
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'chatgpt_text',
    displayName: 'ChatGPT (文本生成)',
    description: '使用 ChatGPT 官网生成文本，支持多模型切换和图片上传。需要已登录的 ChatGPT 账户，若需要选择模型，请使用会员账号 (包含 K12 教室认证账号)。',

    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    models: [
        {
            id: 'gpt-5.3',
            testId: 'model-switcher-gpt-5-3',
            imagePolicy: 'optional'
        },
        {
            id: 'gpt-5.4-thinking',
            testId: 'model-switcher-gpt-5-4-thinking',
            imagePolicy: 'optional'
        }
    ],

    navigationHandlers: [],

    generate
};
