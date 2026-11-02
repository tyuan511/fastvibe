package dev.fastvibe.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GlassBottomSheet(
    onDismissRequest: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(40.dp),
        containerColor = Color.Transparent,
        scrimColor = if (MaterialTheme.colorScheme.background.red < .1f) Color.Black.copy(alpha = .5f) else Color(0xFF141828).copy(alpha = .20f),
        dragHandle = null,
    ) {
        GlassPanel(Modifier.fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp - 72).coerceAtLeast(240).dp), RoundedCornerShape(40.dp), high = true, sheet = true) {
            Column(Modifier.fillMaxWidth()) {
                Box(Modifier.align(Alignment.CenterHorizontally).padding(top = 10.dp).size(36.dp, 5.dp)
                    .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = MaterialTheme.colorScheme.onSurfaceVariant.alpha * .35f), CircleShape))
                content()
            }
        }
    }
}
