package dev.fastvibe.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class MobileDeviceNameTest {
    @Test fun systemNameWinsAndKeepsUnicode() {
        assertEquals("小唐的 Pixel", resolveMobileDeviceName({ "  小唐的 Pixel  " }, "Pixel 9"))
    }

    @Test fun missingOrBlankSystemNameFallsBackToModel() {
        for (name in listOf(null, "", " \n ")) {
            assertEquals("Pixel 9", resolveMobileDeviceName({ name }, " Pixel 9 "))
        }
    }

    @Test fun unavailableSystemSettingDoesNotRequirePermissions() {
        assertEquals("Pixel 9", resolveMobileDeviceName({ throw SecurityException("Denied") }, "Pixel 9"))
        assertEquals("Android device", resolveMobileDeviceName({ throw IllegalArgumentException("Unsupported") }, null))
    }

    @Test fun unusableModelsHaveANonemptyFallback() {
        for (model in listOf(null, "", " \n ", "unknown", " UNKNOWN ")) {
            assertEquals("Android device", resolveMobileDeviceName({ null }, model))
        }
    }
}
