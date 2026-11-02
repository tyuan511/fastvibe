package dev.fastvibe.mobile.core

import org.junit.Assert.assertTrue
import org.junit.Test

class RustCoreBridgeApiTest {
    @Test
    fun commandRequestCreatesAppProtocolCallEnvelope() {
        val request = RustCoreBridge.commandRequestJson("workspace:list", "{\"path\":\".\"}")
        assertTrue(request.contains("\"action\":\"workspace:list\""))
        assertTrue(request.contains("\"path\":\".\""))
    }

    @Test
    fun emptyObjectDoesNotAddTrailingComma() {
        assertTrue(RustCoreBridge.commandRequestJson("devices", "{}") == "{\"action\":\"devices\"}")
        assertTrue(RustCoreBridge.commandRequestJson("devices", "{  }") == "{\"action\":\"devices\"}")
    }

    @Test
    fun missingNativeLibraryFailsWithBuildGuidance() {
        try {
            RustCoreBridge().version()
        } catch (error: IllegalStateException) {
            assertTrue(error.message!!.contains(":native:buildRustAndroid"))
        }
    }
}
