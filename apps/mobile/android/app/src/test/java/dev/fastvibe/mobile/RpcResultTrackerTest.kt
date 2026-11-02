package dev.fastvibe.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RpcResultTrackerTest {
    @Test
    fun preservesJsonArrayIdentityOnSuccessfulCompletion() {
        val tracker = RpcResultTracker { 0L }
        val payload = JSONArray()
            .put("first")
            .put(JSONObject().put("kind", "value"))
        var received: Any? = null

        tracker.register(1L, { received = it }, { error("unexpected failure: $it") })

        assertTrue(tracker.complete(1L, RpcResult(ok = true, result = payload)))
        assertSame(payload, received)
        assertEquals(2, (received as JSONArray).length())
        assertEquals(0, tracker.size)
    }

    @Test
    fun registeringQueuedRequestDoesNotInvokeSuccessUntilCompletion() {
        val tracker = RpcResultTracker { 0L }
        var successCount = 0
        var failureCount = 0

        tracker.register(7L, { successCount++ }, { failureCount++ })

        assertEquals(0, successCount)
        assertEquals(0, failureCount)
        assertEquals(1, tracker.size)

        assertTrue(tracker.complete(7L, RpcResult(ok = true, result = "done")))
        assertEquals(1, successCount)
        assertEquals(0, failureCount)
        assertEquals(0, tracker.size)
    }

    @Test
    fun expiresWaiterOnceAtItsDeadline() {
        var now = 0L
        val tracker = RpcResultTracker { now }
        val failures = mutableListOf<String>()

        tracker.register(10L, { error("unexpected success") }, { failures += it })

        now = 44_999L
        tracker.expire()
        assertTrue(failures.isEmpty())
        assertEquals(1, tracker.size)

        now = 45_000L
        tracker.expire()
        assertEquals(1, failures.size)
        assertTrue(failures.single().contains("超时"))
        assertEquals(0, tracker.size)

        tracker.expire()
        assertEquals(1, failures.size)
    }

    @Test
    fun failsAllOutstandingWaitersOnceAndClearsThem() {
        val tracker = RpcResultTracker { 0L }
        val failures = mutableListOf<Pair<Long, String>>()

        listOf(1L, 2L, 3L).forEach { id ->
            tracker.register(id, { error("unexpected success for $id") }, { failures += id to it })
        }

        tracker.failAll("连接已关闭")

        assertEquals(3, failures.size)
        assertEquals(setOf(1L, 2L, 3L), failures.map { it.first }.toSet())
        assertTrue(failures.all { it.second == "连接已关闭" })
        assertEquals(0, tracker.size)

        tracker.failAll("连接已关闭")
        assertEquals(3, failures.size)
    }

    @Test
    fun unknownRequestDoesNotCompleteAnotherWaiter() {
        val tracker = RpcResultTracker { 0L }
        var received: Any? = null

        tracker.register(20L, { received = it }, { error("unexpected failure: $it") })

        assertFalse(tracker.complete(19L, RpcResult(ok = true, result = "stale")))
        assertEquals(null, received)
        assertEquals(1, tracker.size)

        assertTrue(tracker.complete(20L, RpcResult(ok = true, result = "current")))
        assertEquals("current", received)
        assertEquals(0, tracker.size)
    }

    @Test
    fun callbacksCanRegisterNewWaitersWhileResolving() {
        var now = 0L
        val tracker = RpcResultTracker { now }
        val successes = mutableListOf<Long>()
        val failures = mutableListOf<String>()

        tracker.register(30L, {
            successes += 30L
            tracker.register(31L, { successes += 31L }, { failures += it })
        }, { failures += it })
        assertTrue(tracker.complete(30L, RpcResult(ok = true)))
        assertEquals(1, tracker.size)
        assertTrue(tracker.complete(31L, RpcResult(ok = true)))

        tracker.register(32L, { successes += 32L }, {
            failures += it
            tracker.register(33L, { successes += 33L }, { failures += it })
        })
        now = 45_000L
        tracker.expire()
        assertEquals(1, tracker.size)
        assertTrue(tracker.complete(33L, RpcResult(ok = true)))

        tracker.register(34L, { successes += 34L }, {
            failures += it
            tracker.register(35L, { successes += 35L }, { failures += it })
        })
        tracker.failAll("disconnect")
        assertEquals(1, tracker.size)
        assertTrue(tracker.complete(35L, RpcResult(ok = true)))

        assertEquals(listOf(30L, 31L, 33L, 35L), successes)
        assertEquals(2, failures.size)
        assertTrue(failures[0].contains("超时"))
        assertEquals("disconnect", failures[1])
        assertEquals(0, tracker.size)
    }
}
