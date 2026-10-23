/**
 * DSH GitHub Flow - 通用 Markdown 格式化原子工具与状态徽章
 *
 * 状态徽章的实现已下沉到 `src/shared/state-badges.ts`（与客户端 UI 共用同一份映射）。
 * 这里保留 `format*Badge` 的函数名与签名，服务端 14 处调用点零改动。
 */
import { badgeText, prStateBadge, ciBadge, conflictBadge, releaseBadge, } from '../shared/state-badges.js';
/** 安全清洗表格单元格文本：转义竖线，压缩换行，限制最大长度 */
export function sanitizeCell(text, maxLen = 80) {
    if (text === null || text === undefined || text === '')
        return '-';
    const clean = String(text)
        .replace(/\|/g, '\\|')
        .replace(/[\r\n]+/g, ' ')
        .trim();
    if (clean.length > maxLen) {
        return clean.slice(0, maxLen - 1) + '…';
    }
    return clean || '-';
}
/** 格式化 PR / Issue 状态药丸徽章 */
export function formatStateBadge(state, isDraft) {
    return badgeText(prStateBadge(state, isDraft));
}
/**
 * 格式化 CI 工作流状态徽章。
 * 第二参数按调用域语义不同：run 域传 conclusion（success/failure/cancelled/skipped），
 * pr checks 域传 bucket（pass/fail/pending/skipping/cancel）——取值族不同但映射到
 * 同一组徽章；state 参数兜底（in_progress/queued 等进行中态）。
 */
export function formatCiBadge(status, conclusion) {
    return badgeText(ciBadge(status, conclusion));
}
/** 格式化合并冲突状态 */
export function formatConflictBadge(status) {
    return badgeText(conflictBadge(status));
}
/** 格式化 Release 状态徽章 */
export function formatReleaseBadge(isDraft, isPrerelease) {
    return badgeText(releaseBadge(isDraft, isPrerelease));
}
/**
 * 降级链路可见标注（runGuarded 契约的渲染兑现）。
 * 为什么必须可见：降级若是静默的，Agent 就无法感知能力边界（同一 action 在
 * 不同 gh 版本上走不同链路）；一条 blockquote 注释成本一行，换链路透明。
 */
export function appendDegradedNote(value) {
    if (value && value.degraded === true && value.degradedReason) {
        return `\n\n> ⚠️ ${value.degradedReason}`;
    }
    return '';
}
/**
 * 【pi 移植新增】把逐条失败原因渲染出来。
 *
 * 为什么需要：`tools/image-utils.js` 的 downloadImages 约定「failures 记录原因由调用方透传给
 * Agent」，但各领域渲染器的 message 早退分支只输出 message，failures 整段丢失。
 * 实测后果：raw.githubusercontent.com 被网络拦截时，用户只看到「请求 1 张，被拒 0 张」，
 * 无法区分是网络不通、鉴权失败还是内容不是图片——没有任何可操作信息。
 */
export function appendFailures(value) {
    if (!value || !Array.isArray(value.failures) || value.failures.length === 0)
        return '';
    return '\n\n**失败/提示：**\n' + value.failures.map((f) => `- ${String(f)}`).join('\n');
}
