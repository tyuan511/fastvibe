package dev.fastvibe.mobile

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp

@Composable
internal fun mobileStatusBarInset(): androidx.compose.ui.unit.Dp {
    val density = LocalDensity.current
    val inset = with(density) { WindowInsets.statusBars.getTop(this).toDp() }
    return maxOf(50.dp, inset)
}

@Composable
internal fun Modifier.mobileStatusBarsPadding(): Modifier = padding(top = mobileStatusBarInset())

@Composable
internal fun Modifier.mobileNavigationBarsPadding(minimum: androidx.compose.ui.unit.Dp = 36.dp): Modifier {
    val density = LocalDensity.current
    val inset = with(density) { WindowInsets.navigationBars.getBottom(this).toDp() }
    return padding(bottom = maxOf(minimum, inset))
}
