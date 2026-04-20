<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import {
    DesktopOutlined,
    DisconnectOutlined,
    ExpandOutlined,
    CompressOutlined,
    ReloadOutlined,
    CopyOutlined,
    SnippetsOutlined
} from '@ant-design/icons-vue';

const settingsStore = useSettingsStore();

// 状态
const loading = ref(true);
const vncStatus = ref(null);
const connectionState = ref('disconnected'); // disconnected, connecting, connected, error
const errorMessage = ref('');
const isFullscreen = ref(false);
const remoteClipboardText = ref('');

// DOM 引用
const vncContainer = ref(null);

// noVNC 实例
let rfb = null;
let RFB = null;

// 获取 VNC 状态
async function fetchVncStatus() {
    try {
        const res = await fetch('/admin/vnc/status', {
            headers: settingsStore.getHeaders()
        });
        if (res.ok) {
            vncStatus.value = await res.json();
        }
    } catch (e) {
        console.error('获取 VNC 状态失败', e);
    } finally {
        loading.value = false;
    }
}

// 连接 VNC
async function connectVnc() {
    if (!vncStatus.value?.enabled) return;

    connectionState.value = 'connecting';
    errorMessage.value = '';

    try {
        // 动态导入 noVNC
        if (!RFB) {
            const module = await import('@novnc/novnc/core/rfb.js');
            RFB = module.default;
        }

        // 构建 WebSocket URL
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/admin/vnc?token=${settingsStore.token}`;

        // 创建 RFB 实例
        rfb = new RFB(vncContainer.value, wsUrl, {
            wsProtocols: ['binary']
        });

        // 配置
        rfb.scaleViewport = true;   // 缩放远程画面以适应容器
        rfb.clipViewport = false;   // 不裁剪视口
        rfb.resizeSession = false;   // 允许调整远程会话分辨率

        // 事件监听
        rfb.addEventListener('connect', () => {
            connectionState.value = 'connected';
        });

        rfb.addEventListener('disconnect', (e) => {
            connectionState.value = 'disconnected';
            if (e.detail.clean === false) {
                errorMessage.value = '连接意外断开';
            }
            rfb = null;
        });

        rfb.addEventListener('credentialsrequired', () => {
            rfb.sendCredentials({ password: '' });
        });

        rfb.addEventListener('clipboard', (e) => {
            remoteClipboardText.value = e.detail?.text || '';
        });

    } catch (e) {
        connectionState.value = 'error';
        errorMessage.value = e.message || '连接失败';
    }
}

// 断开连接
function disconnectVnc() {
    if (rfb) {
        rfb.disconnect();
        rfb = null;
    }
    connectionState.value = 'disconnected';
}

// 切换全屏
function toggleFullscreen() {
    if (!vncContainer.value) return;

    if (!document.fullscreenElement) {
        vncContainer.value.requestFullscreen();
        isFullscreen.value = true;
    } else {
        document.exitFullscreen();
        isFullscreen.value = false;
    }
}

// 同步远程剪切板到本地
async function syncRemoteClipboardToLocal() {
    if (connectionState.value !== 'connected') {
        errorMessage.value = '请先连接 VNC';
        return;
    }
    if (!remoteClipboardText.value) {
        errorMessage.value = '当前没有可同步的远程剪切板内容，请先在远程窗口中复制文本';
        return;
    }
    try {
        await navigator.clipboard.writeText(remoteClipboardText.value);
        errorMessage.value = '';
    } catch (e) {
        errorMessage.value = e?.message || '写入本地剪切板失败';
    }
}

// 同步本地剪切板到远程
async function syncLocalClipboardToRemote() {
    if (connectionState.value !== 'connected' || !rfb) {
        errorMessage.value = '请先连接 VNC';
        return;
    }
    try {
        const text = await navigator.clipboard.readText();
        if (!text) {
            errorMessage.value = '本地剪切板为空';
            return;
        }
        rfb.clipboardPasteFrom(text);
        errorMessage.value = '';
    } catch (e) {
        errorMessage.value = e?.message || '读取本地剪切板失败';
    }
}

// 监听全屏变化
function handleFullscreenChange() {
    isFullscreen.value = !!document.fullscreenElement;
}

onMounted(async () => {
    await fetchVncStatus();
    document.addEventListener('fullscreenchange', handleFullscreenChange);
});

onUnmounted(() => {
    disconnectVnc();
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
});
</script>

<template>
    <a-layout style="background: transparent;">
        <a-card title="虚拟显示器" :bordered="false" style="height: 100%">
            <!-- 加载中 -->
            <div v-if="loading" style="text-align: center; padding: 48px;">
                <a-spin size="large" />
                <div style="margin-top: 16px; color: #8c8c8c;">正在检查 VNC 状态...</div>
            </div>

            <!-- 非 xvfbMode -->
            <div v-else-if="!vncStatus?.xvfbMode" style="text-align: center; padding: 48px;">
                <DisconnectOutlined style="font-size: 64px; color: #bfbfbf;" />
                <div style="margin-top: 16px; font-size: 16px; color: #595959;">程序未使用虚拟显示器运行</div>
                <div style="margin-top: 8px; color: #8c8c8c;">
                    VNC 远程显示功能仅在 Linux 环境下使用 <code>-xvfb -vnc</code> 参数启动时可用
                </div>
            </div>

            <!-- xvfbMode 但 VNC 未启用 -->
            <div v-else-if="!vncStatus?.enabled" style="text-align: center; padding: 48px;">
                <DesktopOutlined style="font-size: 64px; color: #bfbfbf;" />
                <div style="margin-top: 16px; font-size: 16px; color: #595959;">VNC 服务未启动</div>
                <div style="margin-top: 8px; color: #8c8c8c;">
                    请确保启动时包含 <code>-vnc</code> 参数，并已安装 x11vnc
                </div>
            </div>

            <!-- VNC 可用 -->
            <div v-else>
                <!-- 控制栏 -->
                <div style="margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <a-tag v-if="connectionState === 'connected'" color="success">已连接</a-tag>
                        <a-tag v-else-if="connectionState === 'connecting'" color="processing">连接中...</a-tag>
                        <a-tag v-else-if="connectionState === 'error'" color="error">连接错误</a-tag>
                        <a-tag v-else color="default">未连接</a-tag>
                        <span v-if="errorMessage" style="margin-left: 8px; color: #ff4d4f; font-size: 12px;">
                            {{ errorMessage }}
                        </span>
                    </div>
                    <a-space>
                        <a-button v-if="connectionState !== 'connected'" type="primary" @click="connectVnc"
                            :loading="connectionState === 'connecting'">
                            <template #icon>
                                <DesktopOutlined />
                            </template>
                            连接
                        </a-button>
                        <a-button v-else danger @click="disconnectVnc">
                            <template #icon>
                                <DisconnectOutlined />
                            </template>
                            断开
                        </a-button>
                        <a-button @click="syncLocalClipboardToRemote" :disabled="connectionState !== 'connected'">
                            <template #icon>
                                <SnippetsOutlined />
                            </template>
                            本地剪切板 to VNC
                        </a-button>
                        <a-button @click="syncRemoteClipboardToLocal" :disabled="connectionState !== 'connected'">
                            <template #icon>
                                <CopyOutlined />
                            </template>
                            VNC剪切板 to 本地
                        </a-button>
                        <a-button @click="toggleFullscreen" :disabled="connectionState !== 'connected'">
                            <template #icon>
                                <CompressOutlined v-if="isFullscreen" />
                                <ExpandOutlined v-else />
                            </template>
                        </a-button>
                        <a-button @click="fetchVncStatus">
                            <template #icon>
                                <ReloadOutlined />
                            </template>
                        </a-button>
                    </a-space>
                </div>

                <!-- VNC 显示区域 -->
                <div ref="vncContainer"
                    style="width: 100%; aspect-ratio: 16/9; min-height: 400px; max-height: 70vh; background: #000; border-radius: 8px; overflow: hidden;">
                    <div v-if="connectionState === 'disconnected'"
                        style="height: 100%; display: flex; align-items: center; justify-content: center; color: #595959;">
                        <div style="text-align: center;">
                            <DesktopOutlined style="font-size: 48px; color: #434343;" />
                            <div style="margin-top: 16px;">点击"连接"按钮查看远程显示器</div>
                        </div>
                    </div>
                </div>

                <!-- 信息 -->
                <div style="margin-top: 12px; font-size: 12px; color: #8c8c8c;">
                    显示器: {{ vncStatus.display }} | VNC 端口: {{ vncStatus.port }}
                </div>
            </div>
        </a-card>
    </a-layout>
</template>
