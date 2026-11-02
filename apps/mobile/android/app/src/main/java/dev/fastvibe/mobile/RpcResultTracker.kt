package dev.fastvibe.mobile

internal data class RpcResult(val ok: Boolean, val result: Any? = null, val error: String? = null)

/** Completion is the server reply; a queued native command only registers a waiter. */
internal class RpcResultTracker(private val now: () -> Long = { System.nanoTime() / 1_000_000 }) {
    private data class Waiter(
        val deadline: Long,
        val success: (Any?) -> Unit,
        val failure: (String) -> Unit,
    )

    private val waiters = mutableMapOf<Long, Waiter>()
    val size: Int get() = waiters.size

    fun register(id: Long, success: (Any?) -> Unit, failure: (String) -> Unit) {
        waiters.remove(id)?.failure?.invoke("请求已被替换。")
        waiters[id] = Waiter(now() + 45_000, success, failure)
    }

    fun complete(id: Long, result: RpcResult): Boolean {
        val waiter = waiters.remove(id) ?: return false
        if (result.ok) waiter.success(result.result) else waiter.failure(result.error ?: "服务器请求失败。")
        return true
    }

    fun expire() {
        val expired = waiters.filterValues { it.deadline <= now() }.keys.toList()
        expired.forEach { id -> waiters.remove(id)?.failure?.invoke("请求等待超时。操作可能已到达电脑，请刷新确认；草稿已保留。") }
    }

    fun failAll(message: String) {
        val outstanding = waiters.values.toList()
        waiters.clear()
        outstanding.forEach { it.failure(message) }
    }
}
