package dev.fastvibe.mobile

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
internal fun GlassIconButton(resource: Int, description: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    GlassPanel(modifier.size(44.dp).semantics { contentDescription = description }.glassClick(onClick = onClick), CircleShape, high = true) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            val back = resource == R.drawable.fv_chevron_left
            Image(painterResource(resource), null, Modifier.size(if (back) 22.dp else 20.dp).then(if (back) Modifier.offset(x = (-1).dp) else Modifier), colorFilter = ColorFilter.tint(MaterialTheme.colorScheme.onSurface))
        }
    }
}
