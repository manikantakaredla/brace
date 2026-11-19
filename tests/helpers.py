def raises(exc_type, fn):
    try:
        fn()
    except exc_type:
        return True
    return False
