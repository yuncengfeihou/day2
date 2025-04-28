// 文件: public/extensions/third-party/day2/index.js

import { extension_settings, loadExtensionSettings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getContext, saveSettingsDebounced, eventSource, event_types, getTokenCountAsync } from '../../../../script.js'; // 确保 getTokenCountAsync 已导入

(function () {
    // --- 插件基础信息 ---
    const extensionName = "day2";
    const pluginFolderName = "day2";
    const extensionFolderPath = `scripts/extensions/third-party/${pluginFolderName}`;
    const extensionSettings = extension_settings[extensionName] || {};
    const defaultSettings = {};

    // --- 插件状态变量 ---
    let day1Worker;
    let currentEntityId = null;
    let currentEntityName = null;

    // --- IndexedDB 相关 ---
    const DB_NAME = 'SillyTavernDay1Stats';
    const STORE_NAME = 'dailyStats';
    const DB_VERSION = 1;
    let dbInstance;

    function openDBMain() {
        return new Promise((resolve, reject) => {
            if (dbInstance) { resolve(dbInstance); return; }
            console.log("Day1 Main: Attempting to open IndexedDB...");
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (event) => { console.error("Day1 Main: IndexedDB open error:", event.target.error); reject('IndexedDB error: ' + event.target.error); };
            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                console.log("Day1 Main: IndexedDB connection opened successfully.");
                dbInstance.onerror = (event) => console.error("Day1 Main: Database error:", event.target.error);
                dbInstance.onclose = () => { console.log("Day1 Main: Database connection closed."); dbInstance = null; };
                dbInstance.onversionchange = () => { console.log("Day1 Main: Database version change detected, closing connection."); if (dbInstance) { dbInstance.close(); dbInstance = null; } };
                resolve(dbInstance);
            };
            request.onupgradeneeded = (event) => {
                console.log("Day1 Main: IndexedDB upgrade needed.");
                const db = event.target.result;
                const transaction = event.target.transaction;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    try {
                        db.createObjectStore(STORE_NAME, { keyPath: 'entityId' });
                        console.log(`Day1 Main: Object store "${STORE_NAME}" created.`);
                    } catch (e) {
                         console.error(`Day1 Main: Error creating object store "${STORE_NAME}"`, e);
                         if (transaction) transaction.abort();
                         reject(`Error creating object store: ${e}`);
                         return;
                    }
                }
                console.log("Day1 Main: IndexedDB upgrade finished.");
            };
        });
    }

    function getAllStats() {
        return new Promise(async (resolve, reject) => {
            try {
                const db = await openDBMain();
                const transaction = db.transaction(STORE_NAME, 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.getAll();
                request.onerror = (event) => reject('Error reading all data: ' + event.target.error);
                request.onsuccess = (event) => resolve(event.target.result || []);
            } catch (error) {
                console.error("Day1 Main: Error during getAllStats:", error);
                reject(error);
            }
        });
    }

    // --- Worker 通信 ---
    function sendMessageToWorker(command, payload) {
        if (!day1Worker) { console.error("Day1 Main: Worker not initialized! Cannot send message."); return; }
        day1Worker.postMessage({ command, payload });
    }

    // --- UI 更新 ---
    async function updateStatsTable() {
        const tableBody = $('#day1-stats-table-body');
        if (!tableBody.length) { console.warn("Day1 Main: Stats table body not found in DOM."); return; }
        tableBody.empty().append('<tr><td colspan="5"><i>正在加载统计数据...</i></td></tr>');

        try {
            const allStats = await getAllStats();
            const todayString = new Date().toISOString().split('T')[0];
            tableBody.empty();

            if (allStats.length === 0) {
                tableBody.append('<tr><td colspan="5"><i>暂无任何统计数据。</i></td></tr>');
                return;
            }

            let hasTodayData = false;
            allStats.sort((a, b) => (a.entityName || a.entityId || '').localeCompare(b.entityName || b.entityId || ''));

            allStats.forEach(entityStats => {
                const dailyData = entityStats.dailyData ? entityStats.dailyData[todayString] : null;
                if (dailyData) {
                    hasTodayData = true;
                    // **修改行格式以包含单独的 Token 计数**
                    const row = `
                        <tr>
                            <td>${entityStats.entityName || entityStats.entityId}</td>
                            <td>${dailyData.userMessages || 0} (${dailyData.userTokens || 0} tk)</td>
                            <td>${dailyData.aiMessages || 0} (${dailyData.aiTokens || 0} tk)</td>
                            <td>${dailyData.cumulativeTokens || 0}</td>
                            <td>${todayString}</td>
                        </tr>
                    `;
                    tableBody.append(row);
                }
            });

            if (!hasTodayData) {
                 tableBody.append(`<tr><td colspan="5"><i>今天 (${todayString}) 还没有聊天记录。</i></td></tr>`);
            }

        } catch (error) {
            console.error('Day1 Main: Error fetching or updating stats table:', error);
            tableBody.empty().append('<tr><td colspan="5"><i style="color: red;">加载统计数据失败，请检查控制台。</i></td></tr>');
        }
    }

    // --- 事件处理 ---

    /**
     * 处理单条消息，计算 Token 并发送给 Worker 进行记录。
     * @param {object} message SillyTavern 的消息对象。
     * @param {boolean} isUser 标记消息是否由用户发送。
     */
    async function handleMessage(message, isUser) {
        if (!message || !currentEntityId) return;

        let tokenCount = 0;
        try {
            if (typeof message?.extra?.token_count === 'number' && message.extra.token_count > 0) {
                tokenCount = message.extra.token_count;
            } else if (message.mes) {
                tokenCount = await getTokenCountAsync(message.mes || '', 0);
            }
        } catch (err) {
            console.warn("Day1 Main: Failed to get token count, estimating...", err);
            tokenCount = Math.round((message.mes || '').length / 3.5);
        }

        const payload = {
            entityId: currentEntityId,
            entityName: currentEntityName,
            isUser: isUser,
            tokenCount: tokenCount,
            timestamp: message.send_date || Date.now(),
        };
        sendMessageToWorker('processMessage', payload);
    }

    /**
     * 处理构建好的 Prompt，计算其 Token 数并发送给 Worker 进行累加。
     * @param {object} eventData - 事件对象，包含 prompt 和 dryRun 属性。
     */
    async function handlePromptBuilt(eventData) {
        if (!eventData || eventData.dryRun || !currentEntityId) {
            // 如果是 dryRun 或没有当前实体，则忽略
            return;
        }

        const finalPrompt = eventData.prompt;
        if (typeof finalPrompt !== 'string' || finalPrompt.length === 0) {
             console.warn("Day1 Main: Received empty or invalid prompt in GENERATE_AFTER_COMBINE_PROMPTS event.");
             return;
        }

        try {
            // 计算完整 Prompt 的 Token 数量
            // 注意：这里的 padding 应该与 Generate 函数最终使用的 padding 一致，通常是 power_user.token_padding
            const promptTokenCount = await getTokenCountAsync(finalPrompt, power_user.token_padding || 0);

            // 发送给 Worker 记录
            const payload = {
                entityId: currentEntityId,
                entityName: currentEntityName,
                timestamp: Date.now(), // 使用当前时间戳记录 Prompt 发送时间点
                promptTokenCount: promptTokenCount,
            };
            sendMessageToWorker('recordPromptTokens', payload);
            // console.log(`Day1 Main: Sent ${promptTokenCount} prompt tokens to worker for ${currentEntityId}`);

        } catch(error) {
            console.error("Day1 Main: Error calculating or sending prompt tokens to worker:", error);
        }
    }


    function onMessageSent(messageId) {
        const context = getContext();
        if (!context || !context.chat || !context.chat[messageId]) return;
        const message = context.chat[messageId];
        handleMessage(message, true);
    }

    function onMessageReceived(messageId) {
        const context = getContext();
        if (!context || !context.chat || !context.chat[messageId]) return;
        const message = context.chat[messageId];
        if (message && !message.is_user && !message.is_system) {
            handleMessage(message, false);
        }
    }

    function onChatChanged(chatId) {
        const context = getContext();
        if (!context) { currentEntityId = null; currentEntityName = null; return; }
        if (context.groupId) {
            currentEntityId = String(context.groupId); // 确保是字符串
            currentEntityName = context.groups?.find(g => String(g.id) === currentEntityId)?.name || currentEntityId;
        } else if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
            currentEntityId = context.characters[context.characterId].avatar;
            currentEntityName = context.characters[context.characterId].name;
        } else {
            currentEntityId = null;
            currentEntityName = null;
        }
        console.log(`Day1 Main: Chat context changed. Current entity: ${currentEntityName || 'None'} (ID: ${currentEntityId || 'None'})`);
    }

    // --- 插件初始化 ---
    jQuery(async () => {
        console.log(`Day1 Main: Initializing extension ${extensionName}...`);
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        Object.assign(extension_settings[extensionName], { ...defaultSettings, ...extension_settings[extensionName] });

        try {
            await openDBMain();
            console.log("Day1 Main: Initial DB connection/setup successful.");
        } catch (error) {
            console.error("Day1 Main: Critical - Failed initial DB open/setup:", error);
            alert("Day1 插件数据库初始化失败，统计功能可能无法正常工作。请检查浏览器控制台获取详细信息。");
        }

        try {
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
            const targetContainer = $('#translation_container').length ? '#translation_container' : '#extensions_settings';
            $(targetContainer).append(settingsHtml);
            console.log(`Day1 Main: Settings UI injected into ${targetContainer}`);
            $('#day1-refresh-button').on('click', updateStatsTable);
            setTimeout(updateStatsTable, 500);
        } catch (error) {
            console.error(`Day1 Main: Error loading or injecting settings HTML: ${error}`);
        }

        try {
            const workerPath = `${extensionFolderPath}/worker.js`; // 使用变量
            day1Worker = new Worker(workerPath);
            day1Worker.onmessage = (event) => console.log("Day1 Main: Received message from worker:", event.data);
            day1Worker.onerror = (error) => {
                console.error("Day1 Main: Worker error reported:", error.message, error);
                // 可以在这里添加更用户友好的错误提示
                // toastr.error("后台统计进程出错，请检查控制台。", "Day1 插件错误");
            };
            console.log(`Day1 Main: Web Worker initialized successfully from path: ${workerPath}`);
        } catch (error) {
            console.error(`Day1 Main: Failed to initialize Web Worker from path "${extensionFolderPath}/worker.js":`, error);
            alert("Day1 插件未能成功加载后台处理程序，统计功能将不可用。请检查浏览器控制台错误信息，特别是关于 Worker 路径和 MIME 类型的问题。");
            day1Worker = null;
        }

        // 注册事件监听器
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        // **新增：监听 Prompt 构建完成事件**
        eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, handlePromptBuilt);

        onChatChanged(getContext()?.chatId);

        console.log(`Day1 Main: Extension ${extensionName} initialization complete.`);
    });

})();
