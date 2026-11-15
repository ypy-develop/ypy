<div ypy-get="{{ route('items') }}" ypy-target="#out">
    @if(request()->header('YPY-Request'))
        <span ypy-swap="none"></span>
    @endif
</div>
