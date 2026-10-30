# FastVibe patch to block 0.1.6

The upstream `_NSConcreteStackBlock` declaration used an uninhabited enum as
the type of an extern static, which Rust warns will become an error. Declare
the symbol as a byte and take its raw address, cast to the existing opaque
class pointer type. The code uses only the symbol's address; it does not read
the byte or change the Objective-C block layout. The formerly implicit C ABIs
are also written explicitly to avoid compiler deprecation warnings.

This patch can be removed when all dependencies migrate away from `block` or
an upstream release fixes the declaration.
