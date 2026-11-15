<div acme-get="{{ route('items') }}" acme-target="#out">
    @if(request()->header('ACME-Request'))
        <span acme-swap="none"></span>
    @endif
</div>
